'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FINGER_COUNT, add, hashKey, inInterval, validateId } = require('./ring');

const CATALOG_NAME = 'catalogo.txt';

class ChordNode {
  constructor({ id, host = '127.0.0.1', port = 5000, requestTimeout = 10000,
    storageDirectory } = {}) {
    this.id = validateId(id);
    this.host = String(host || '').trim();
    this.replicaTargets = [];

    if (!this.host || this.host === '0.0.0.0' || this.host === '::') {
      throw new Error('Informe o IP ou hostname pelo qual os outros nós acessam esta máquina');
    }

    this.port = Number(port);

    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error('A porta deve ser um inteiro entre 1 e 65535');
    }

    this.requestTimeout = requestTimeout;
    this.storageDirectory = storageDirectory || path.join(
      process.cwd(), 'data', `node-${this.id}-${this.port}`
    );

    this.replicaDirectory = `${this.storageDirectory}-replica`;
    this.predecessor = null;
    this.fingers = this.buildEmptyFingerTable();
    this.joined = false;
  }

  get reference() {
    return { id: this.id, host: this.host, port: this.port };
  }

  buildEmptyFingerTable() {
    return Array.from({ length: FINGER_COUNT }, (_, index) => ({
      index: index + 1,
      start: add(this.id, 2 ** index),
      node: null
    }));
  }

  get successor() {
    return this.fingers[0].node;
  }

  set successor(node) {
    this.fingers[0].node = node;
  }

  createRing() {
    this.predecessor = this.reference;

    for (const finger of this.fingers) {
      finger.node = this.reference;
    }

    this.joined = true;
  }

  async join(bootstrap) {
    if (this.joined) {
      throw new Error('Este nó já pertence a uma rede Chord');
    }

    if (!bootstrap) {
      this.createRing();
      return this.state();
    }

    const contact = normalizeReference(bootstrap);

    if (contact.id === this.id) {
      throw new Error('O nó de entrada não pode ter o mesmo id');
    }

    const successor = await this.rpc(contact, '/rpc/find-successor', {
      method: 'POST',
      body: { id: this.id }
    });

    if (successor.id === this.id) {
      throw new Error(`O id ${this.id} já está em uso`);
    }

    const predecessorResult = await this.rpc(successor, '/rpc/predecessor');
    const predecessor = predecessorResult.node || successor;

    this.successor = successor;
    this.predecessor = predecessor;

    await this.rpc(successor, '/rpc/predecessor', {
      method: 'PUT',
      body: { node: this.reference }
    });

    if (predecessor.id !== successor.id) {
      await this.rpc(predecessor, '/rpc/successor', {
        method: 'PUT',
        body: { node: this.reference }
      });
    } else {
      await this.rpc(successor, '/rpc/successor', {
        method: 'PUT',
        body: { node: this.reference }
      });
    }

    this.joined = true;

    await this.refreshFingerTable();

    const migration = await this.migrateOwnedFilesFromSuccessor();

    await this.rpc(this.successor, '/rpc/refresh-fingers', {
      method: 'POST',
      body: { originId: this.id, hops: 0 }
    });

    return { ...this.state(), migration };
  }

  async refreshFingerTable() {
    const previousTargets = this.replicaTargets;

    const nodes = await Promise.all(
      this.fingers.map((finger) =>
        this.findSuccessor(finger.start)
      )
    );

    this.fingers.forEach((finger, index) => {
      finger.node = nodes[index];
    });

    const currentTargets = await this.getReplicaTargets();

    await this.ensureSuccessorReplicas();

    await this.removeObsoleteReplicas(
      previousTargets,
      currentTargets
    );
  
    this.replicaTargets = currentTargets;

  }

  async refreshRingFingerTables(originId, hops = 0) {
    validateId(originId);

    if (this.id === Number(originId)) {
      return { ok: true };
    }

    if (hops >= 32) {
      throw new Error('Limite de nós excedido ao atualizar finger tables');
    }

    await this.refreshFingerTable();

    const next = this.successor;

    setImmediate(() => {
      this.rpc(next, '/rpc/refresh-fingers', {
        method: 'POST',
        body: {
          originId: Number(originId),
          hops: hops + 1
        }
      }).catch((error) => {
        console.error(
          `Não foi possível atualizar as fingers após o nó ${this.id}: ${error.message}`
        );
      });
    });

    return { ok: true };
  }

  async findSuccessor(rawId, hops = 0) {
    const id = validateId(rawId);

    if (!this.joined || !this.successor) {
      throw new Error('O nó ainda não entrou em uma rede');
    }

    if (this.successor.id === this.id) return this.reference;
    if (id === this.id) return this.reference;

    if (inInterval(id, this.id, this.successor.id, false, true)) {
      return this.successor;
    }

    if (hops >= 32) {
      throw new Error('Limite de saltos excedido ao procurar sucessor');
    }

    let next = this.closestPrecedingFinger(id);

    if (next.id === this.id) {
      next = this.successor;
    }

    return this.rpc(next, '/rpc/find-successor', {
      method: 'POST',
      body: {
        id,
        hops: hops + 1
      }
    });
  }

  closestPrecedingFinger(id) {
    for (let i = this.fingers.length - 1; i >= 0; i -= 1) {
      const candidate = this.fingers[i].node;

      if (
        candidate &&
        candidate.id !== this.id &&
        inInterval(candidate.id, this.id, id, false, false)
      ) {
        return candidate;
      }
    }

    return this.reference;
  }

  async put(fileName, content, { updateCatalog = true } = {}) {
    this.assertJoined();

    const name = validateFileName(fileName);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hashId = hashKey(name);
    const owner = await this.findSuccessor(hashId);

    let storageResult;

    if (owner.id === this.id) {
      storageResult = await this.storeOwnedFile(name, bytes);
    } else {
      storageResult = await this.rpc(owner, '/rpc/files', {
        method: 'PUT',
        body: {
          name,
          content: bytes.toString('base64')
        }
      });
    }

    if (updateCatalog && name !== CATALOG_NAME) {
      await this.addToCatalog(name);
    }

    return {
      name,
      hashId,
      node: owner,
      size: bytes.length,
      replicas: storageResult.replicas || []
    };
  }

  async get(fileName) {
    this.assertJoined();

    const name = validateFileName(fileName);
    const hashId = hashKey(name);

    let owner;

    try {
      owner = await this.findSuccessor(hashId);
    } catch (routingError) {
      owner = await this.findOwnerFromKnownTopology(hashId);

      if (!owner) {
        throw routingError;
      }
    }

    try {
      let content;

      if (owner.id === this.id) {
        content = await this.readLocal(name);
      } else {
        const result = await this.rpc(
          owner,
          `/rpc/files?name=${encodeURIComponent(name)}`
        );

        content = Buffer.from(result.content, 'base64');
      }

      return {
        name,
        hashId,
        node: owner,
        servedBy: owner,
        fromReplica: false,
        size: content.length,
        content
      };
    } catch (ownerError) {
      console.log(
        `Proprietário ${owner.id} indisponível ou sem o arquivo. ` +
        `Procurando réplica de "${name}"...`
      );

      const replica = await this.findReplicaInNetwork(owner.id, name);

      if (!replica) {
        throw ownerError;
      }

      console.log(
        `Arquivo "${name}" recuperado da réplica no nó ${replica.node.id}.`
      );

      return {
        name,
        hashId,
        node: owner,
        servedBy: replica.node,
        fromReplica: true,
        size: replica.content.length,
        content: replica.content
      };
    }
  }

  async addToCatalog(fileName) {
    let names = [];

    try {
      const catalog = await this.get(CATALOG_NAME);

      names = catalog.content
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT' && !/não encontrado/i.test(error.message)) {
        throw error;
      }
    }

    if (!names.includes(fileName)) {
      names.push(fileName);
    }

    names.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    await this.put(
      CATALOG_NAME,
      Buffer.from(`${names.join('\n')}\n`),
      { updateCatalog: false }
    );
  }

  async storeLocal(fileName, content) {
    const name = validateFileName(fileName);

    await fs.mkdir(this.storageDirectory, { recursive: true });
    await fs.writeFile(path.join(this.storageDirectory, name), content);
  }

  async readLocal(fileName) {
    const name = validateFileName(fileName);

    try {
      return await fs.readFile(path.join(this.storageDirectory, name));
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error(`Arquivo "${name}" não encontrado na rede`);
        notFound.code = 'ENOENT';
        throw notFound;
      }

      throw error;
    }
  }

  async storeOwnedFile(fileName, content) {
    const name = validateFileName(fileName);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);

    await this.storeLocal(name, bytes);

    const replicas = await this.replicateFileToSuccessors(name, bytes);;

    return {
      ok: true,
      name,
      size: bytes.length,
      replicas
    };
  }

  async getReplicaTargets() {
    const targets = [];
    const visited = new Set([this.id]);
    let current = this.successor;

    while (
      current &&
      targets.length < REPLICATION_FACTOR &&
      !visited.has(current.id)
    ) {
      visited.add(current.id);
      targets.push(current);

      try {
        const state = await this.rpc(
          current,
          '/rpc/state'
        );

        current = state.successor;
      } catch (error) {
        console.error(
          `Não foi possível descobrir o sucessor do nó ` +
          `${current.id}: ${error.message}`
        );

        break;
      }
    }

    return targets;
  }

  async replicateFileToSuccessors(fileName, content) {
    const targets = await this.getReplicaTargets();

    const results = await Promise.allSettled(
      targets.map((target) =>
        this.ensureReplicaOnNode(target, fileName, content)
      )
    );

    return results.map((result, index) => {
      const target = targets[index];

      if (result.status === 'fulfilled') {
        return {
          ok: true,
          ...result.value
        };
      }

      console.error(
        `Não foi possível replicar "${fileName}" no nó ${target.id}: ` +
        result.reason.message
      );

      return {
        ok: false,
        node: target,
        error: result.reason.message
      };
    });
  }

  async ensureReplicaOnNode(target, fileName, content) {
    const expectedHash = sha256(content);

    const status = await this.rpc(
      target,
      `/rpc/replicas/status?ownerId=${this.id}` +
      `&name=${encodeURIComponent(fileName)}`
    );

    if (status.exists && status.sha256 === expectedHash) {
      return {
        updated: false,
        node: target
      };
    }

    await this.rpc(target, '/rpc/replicas', {
      method: 'PUT',
      body: {
        ownerId: this.id,
        name: fileName,
        content: content.toString('base64')
      }
    });

    return {
      updated: true,
      node: target
    };
  }

  async ensureSuccessorReplicas() {
    const files = await this.listLocalFiles();

    for (const fileName of files) {
      const content = await this.readLocal(fileName);

      await this.replicateFileToSuccessors(
        fileName,
        content
      );
    }
  }

  async removeObsoleteFingerReplicas(previousTargets, currentTargets) {
    const currentIds = new Set(
      currentTargets.map((node) => node.id)
    );

    const obsoleteTargets = previousTargets.filter(
      (node) => !currentIds.has(node.id)
    );

    if (obsoleteTargets.length === 0) {
      return;
    }

    const files = await this.listLocalFiles();

    for (const target of obsoleteTargets) {
      for (const fileName of files) {
        try {
          await this.removeReplicaOnNode(
            target,
            this.id,
            fileName
          );

          console.log(
            `Réplica obsoleta "${fileName}" removida do nó ${target.id}.`
          );
        } catch (error) {
          console.error(
            `Não foi possível remover a réplica "${fileName}" do nó ` +
            `${target.id}: ${error.message}`
          );
        }
      }
    }
  }

  async removeReplicaOnNode(target, ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);

    return this.rpc(
      target,
      `/rpc/replicas?ownerId=${owner}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    );
  }

  async listLocalFiles() {
    try {
      const entries = await fs.readdir(
        this.storageDirectory,
        { withFileTypes: true }
      );

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async ownedFilesInRange(startExclusive, endInclusive) {
    const start = validateId(startExclusive);
    const end = validateId(endInclusive);
    const files = await this.listLocalFiles();
    const result = [];

    for (const fileName of files) {
      const hashId = hashKey(fileName);

      if (!inInterval(hashId, start, end, false, true)) {
        continue;
      }

      const content = await this.readLocal(fileName);

      result.push({
        name: fileName,
        hashId,
        size: content.length,
        content: content.toString('base64')
      });
    }

    return result;
  }

  async migrateOwnedFilesFromSuccessor() {
    if (!this.successor || !this.predecessor) return [];
    if (this.successor.id === this.id) return [];

    const source = this.successor;

    const result = await this.rpc(source, '/rpc/owned-files/range', {
      method: 'POST',
      body: {
        startExclusive: this.predecessor.id,
        endInclusive: this.id
      }
    });

    const migrated = [];

    for (const file of result.files || []) {
      const content = Buffer.from(file.content, 'base64');

      const storage = await this.storeOwnedFile(
        file.name,
        content
      );

      await this.rpc(source, '/rpc/owned-files', {
        method: 'DELETE',
        body: {
          name: file.name
        }
      });

      migrated.push({
        name: file.name,
        hashId: file.hashId,
        from: source,
        to: this.reference,
        replicas: storage.replicas
      });

      console.log(
        `Arquivo "${file.name}" migrado do nó ${source.id} para o nó ${this.id}.`
      );
    }

    return migrated;
  }

  async deleteOwnedFile(fileName) {
    const name = validateFileName(fileName);
    const targets = await this.getReplicaTargets();

    let removed = false;

    try {
      await fs.unlink(
        path.join(
          this.storageDirectory,
          name
        )
      );

      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const results = await Promise.allSettled(
      targets.map((target) =>
        this.removeReplicaOnNode(
          target,
          this.id,
          name
        )
      )
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(
          `Não foi possível remover a réplica antiga "${name}" do nó ` +
          `${targets[index].id}: ${result.reason.message}`
        );
      }
    });

    return {
      ok: true,
      removed,
      name
    };
  }

  replicaPath(ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);

    return path.join(
      this.replicaDirectory,
      `owner-${owner}`,
      name
    );
  }

  async storeReplica(ownerId, fileName, content) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const filePath = this.replicaPath(owner, name);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);

    return {
      ok: true,
      ownerId: owner,
      name,
      size: bytes.length,
      sha256: sha256(bytes)
    };
  }

  async replicaStatus(ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);
    const filePath = this.replicaPath(owner, name);

    try {
      const content = await fs.readFile(filePath);

      return {
        exists: true,
        ownerId: owner,
        name,
        size: content.length,
        sha256: sha256(content)
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          exists: false,
          ownerId: owner,
          name
        };
      }

      throw error;
    }
  }

  async readReplica(ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);
    const filePath = this.replicaPath(owner, name);

    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const notFound = new Error(
          `Réplica "${name}" do nó ${owner} não encontrada`
        );

        notFound.code = 'ENOENT';

        throw notFound;
      }

      throw error;
    }
  }

  async deleteReplica(ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);
    const filePath = this.replicaPath(owner, name);

    let removed = false;

    try {
      await fs.unlink(filePath);
      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await fs.rmdir(
        path.dirname(filePath)
      );
    } catch {
    }

    return {
      ok: true,
      removed,
      ownerId: owner,
      name
    };
  }

  async discoverKnownNodes() {
    const known = new Map();
    const queue = [];
    const queried = new Set();

    const addNode = (rawNode) => {
      if (!rawNode) {
        return;
      }

      let node;

      try {
        node = normalizeReference(rawNode);
      } catch {
        return;
      }

      if (!known.has(node.id)) {
        known.set(node.id, node);
        queue.push(node);
      }
    };

    addNode(this.reference);
    addNode(this.predecessor);
    addNode(this.successor);

    for (const finger of this.fingers) {
      addNode(finger.node);
    }

    while (queue.length > 0 && queried.size < 32) {
      const current = queue.shift();

      if (
        current.id === this.id ||
        queried.has(current.id)
      ) {
        continue;
      }

      queried.add(current.id);

      try {
        const state = await this.rpc(
          current,
          '/rpc/state'
        );

        addNode(state.node);
        addNode(state.predecessor);
        addNode(state.successor);

        for (const finger of state.fingerTable || []) {
          addNode(finger.node);
        }
      } catch {
      }
    }

    return [...known.values()];
  }

  async findOwnerFromKnownTopology(rawId) {
    const id = validateId(rawId);
    const nodes = await this.discoverKnownNodes();

    if (nodes.length === 0) {
      return null;
    }

    const ordered = nodes
      .slice()
      .sort((left, right) => left.id - right.id);

    return (
      ordered.find((node) => node.id >= id) ||
      ordered[0]
    );
  }

  async findReplicaInNetwork(ownerId, fileName) {
    const owner = validateId(ownerId);
    const name = validateFileName(fileName);
    const nodes = await this.discoverKnownNodes();

    nodes.sort((left, right) => {
      if (left.id === this.id) return -1;
      if (right.id === this.id) return 1;

      return left.id - right.id;
    });

    for (const node of nodes) {
      if (node.id === owner) {
        continue;
      }

      try {
        if (node.id === this.id) {
          const content = await this.readReplica(
            owner,
            name
          );

          return {
            node: this.reference,
            content
          };
        }

        const result = await this.rpc(
          node,
          `/rpc/replicas/content?ownerId=${owner}` +
          `&name=${encodeURIComponent(name)}`
        );

        return {
          node,
          content: Buffer.from(
            result.content,
            'base64'
          )
        };
      } catch {
      }
    }

    return null;
  }

  assertJoined() {
    if (!this.joined) {
      throw new Error(
        'O nó ainda não entrou em uma rede'
      );
    }
  }

  async rpc(node, route, { method = 'GET', body } = {}) {
    const target = normalizeReference(node);
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeout
    );

    try {
      const response = await fetch(
        `http://${target.host}:${target.port}${route}`,
        {
          method,
          headers: body
            ? { 'content-type': 'application/json' }
            : undefined,
          body: body
            ? JSON.stringify(body)
            : undefined,
          signal: controller.signal
        }
      );

      const data = await response.json();

      if (!response.ok) {
        const rpcError = new Error(
          data.error ||
          `Erro HTTP ${response.status}`
        );

        rpcError.status =
          response.status;

        if (response.status === 404) {
          rpcError.code = 'ENOENT';
        }

        throw rpcError;
      }

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeout = new Error(
          `Tempo limite ao acessar o nó ${target.id} ` +
          `em ${target.host}:${target.port}`
        );

        timeout.code =
          'ETIMEDOUT';

        throw timeout;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  state() {
    return {
      node: this.reference,
      joined: this.joined,
      predecessor: this.predecessor,
      successor: this.successor,
      fingerTable: this.fingers
    };
  }
}

function sha256(content) {
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
}

function validateFileName(fileName) {
  if (
    typeof fileName !== 'string' ||
    !fileName.trim()
  ) {
    throw new Error(
      'O nome do arquivo é obrigatório'
    );
  }

  const name = fileName.trim();

  if (
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(
      'Nome de arquivo inválido'
    );
  }

  return name;
}

function normalizeReference(node) {
  if (!node || typeof node !== 'object') {
    throw new Error(
      'Referência de nó inválida'
    );
  }

  const port = Number(
    node.port || 5000
  );

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      'Porta de referência de nó inválida'
    );
  }

  return {
    id: validateId(node.id),
    host: String(node.host || '127.0.0.1'),
    port
  };
}

module.exports = {
  ChordNode,
  normalizeReference,
  validateFileName,
  CATALOG_NAME
};
'use strict';

const form = document.querySelector('#create-form');
const targetFields = document.querySelector('#target-fields');
const button = document.querySelector('#create-button');
const message = document.querySelector('#create-message');
const list = document.querySelector('#nodes-list');

async function fillNetworkDefaults() {
  try {
    const response = await fetch('/api/network', { cache: 'no-store' });

    if (!response.ok) {
      return;
    }

    const { suggestedHost } =
      await response.json();

    if (!suggestedHost) {
      return;
    }

    document.querySelector('#node-host').value =
      suggestedHost;

    document.querySelector('#target-host').value =
      suggestedHost;
  } catch {
  }
}

function nodeAddress(node) {
  return `${node.host}:${node.port}`;
}

function createStopButton(state) {
  const stopButton =
    document.createElement('button');

  stopButton.className =
    'button secondary';

  stopButton.type =
    'button';

  stopButton.textContent =
    'Desligar';

  stopButton.addEventListener(
    'click',
    async () => {
      stopButton.disabled =
        true;

      try {
        const response =
          await fetch(
            `/api/nodes?port=${state.node.port}`,
            {
              method: 'DELETE'
            }
          );

        const result =
          await response.json();

        if (!response.ok) {
          throw new Error(
            result.error ||
            'Não foi possível desligar o nó'
          );
        }

        message.className =
          'form-message';

        message.textContent =
          `Nó ${result.nodeId} desligado. ` +
          `A queda pode ser usada para testar as réplicas.`;

        await loadNodes();
      } catch (error) {
        message.className =
          'form-message error';

        message.textContent =
          error.message;

        stopButton.disabled =
          false;
      }
    }
  );

  return stopButton;
}

function createNodeCard(state) {
  const card =
    document.createElement('article');

  card.className =
    'node-card';

  const predecessor =
    state.predecessor?.id ?? '—';

  const successor =
    state.successor?.id ?? '—';

  card.innerHTML = `
    <div class="node-card-id">${state.node.id}</div>
    <div>
      <strong>Nó ${state.node.id}</strong>
      <span>${nodeAddress(state.node)}</span>
    </div>
    <div class="node-links">
      <span>← ${predecessor}</span>
      <span>${successor} →</span>
    </div>
    <div class="node-actions">
      <a class="button secondary" href="http://${nodeAddress(state.node)}">
        Abrir painel
      </a>
    </div>`;

  const actions =
    card.querySelector(
      '.node-actions'
    );

  actions.style.display =
    'flex';

  actions.style.gap =
    '8px';

  actions.append(
    createStopButton(state)
  );

  return card;
}

async function loadNodes() {
  try {
    const response =
      await fetch(
        '/api/nodes',
        {
          cache: 'no-store'
        }
      );

    const nodes =
      await response.json();

    if (!response.ok) {
      throw new Error(
        nodes.error ||
        'Não foi possível consultar os nós'
      );
    }

    if (!nodes.length) {
      list.innerHTML =
        '<p class="empty-row">Nenhum nó foi criado.</p>';

      return;
    }

    list.replaceChildren(
      ...nodes.map(
        createNodeCard
      )
    );
  } catch (error) {
    list.innerHTML =
      `<p class="global-error">` +
      `Erro ao consultar os nós: ${error.message}` +
      `</p>`;
  }
}

function buildNodeRequest() {
  const joinsExisting =
    document.querySelector(
      'input[name="mode"]:checked'
    ).value === 'join';

  return {
    id: Number(
      document.querySelector(
        '#node-id'
      ).value
    ),

    host: document.querySelector(
      '#node-host'
    ).value.trim(),

    port: Number(
      document.querySelector(
        '#node-port'
      ).value
    ),

    bootstrap:
      joinsExisting
        ? {
          id: Number(
            document.querySelector(
              '#target-id'
            ).value
          ),

          host: document.querySelector(
            '#target-host'
          ).value.trim(),

          port: Number(
            document.querySelector(
              '#target-port'
            ).value
          )
        }
        : null
  };
}

document
  .querySelectorAll(
    'input[name="mode"]'
  )
  .forEach((radio) => {
    radio.addEventListener(
      'change',
      () => {
        const selected =
          document.querySelector(
            'input[name="mode"]:checked'
          ).value;

        targetFields.hidden =
          selected !== 'join';
      }
    );
  });

form.addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();

    button.disabled =
      true;

    message.className =
      'form-message';

    message.textContent =
      'Iniciando…';

    try {
      const response =
        await fetch(
          '/api/nodes',
          {
            method: 'POST',

            headers: {
              'content-type':
                'application/json'
            },

            body:
              JSON.stringify(
                buildNodeRequest()
              )
          }
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
          'Não foi possível criar o nó'
        );
      }

      const migrated =
        result.migration || [];

      message.textContent =
        migrated.length > 0
          ? `Nó ${result.node.id} iniciado. ${migrated.length} arquivo(s) migrado(s).`
          : `Nó ${result.node.id} iniciado na porta ${result.node.port}.`;

      document.querySelector(
        '#node-port'
      ).value =
        result.node.port + 1;

      await loadNodes();
    } catch (error) {
      message.className =
        'form-message error';

      message.textContent =
        error.message;
    } finally {
      button.disabled =
        false;
    }
  }
);

document
  .querySelector(
    '#refresh-button'
  )
  .addEventListener(
    'click',
    loadNodes
  );

fillNetworkDefaults();
loadNodes();

setInterval(
  loadNodes,
  5000
);
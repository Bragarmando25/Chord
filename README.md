# Rede P2P Chord com replicação

Projeto didático de Sistemas Distribuídos que implementa uma rede P2P baseada no protocolo Chord. A aplicação permite criar nós, visualizar o anel, inserir e recuperar arquivos e acompanhar a distribuição das réplicas.

O espaço de identificadores possui 32 posições (`1..32`). Como `32 = 2⁵`, cada nó mantém cinco entradas na finger table. O projeto requer Node.js 18 ou superior e utiliza somente módulos nativos.

## Funcionalidades

- criação de um novo anel Chord;
- entrada de novos nós por meio de um nó existente;
- atualização de predecessor, sucessor e finger tables;
- roteamento distribuído com `findSuccessor`;
- inserção e recuperação de arquivos por qualquer nó;
- catálogo distribuído com os nomes dos arquivos da rede;
- uma cópia original e até duas réplicas por arquivo;
- migração de arquivos quando a responsabilidade dos hashes muda;
- transferência dos arquivos durante a saída graciosa de um nó;
- recuperação por réplica quando o proprietário não responde;
- painel web para visualizar topologia, arquivos e locais de armazenamento.

## Organização do projeto

```text
src/
├── server.js       # gerenciador dos nós locais, porta 5000
├── node-server.js  # servidor HTTP individual de cada nó
├── chord-node.js   # algoritmo Chord, arquivos e replicação
└── ring.js         # hash e operações do anel circular

public/              # interfaces web
test/ring.test.js    # testes automatizados
data/                # armazenamento local gerado durante a execução
```

A pasta `data/` não faz parte do controle de versão. Ela é criada automaticamente conforme arquivos são inseridos na rede.

## Iniciando a aplicação

Com Node.js 18 ou mais recente instalado, execute:

```bash
npm start
```

No PowerShell, caso a execução de `npm.ps1` esteja bloqueada, utilize:

```powershell
npm.cmd start
```

O gerenciador estará disponível em `http://127.0.0.1:5000`. Essa porta pertence exclusivamente ao gerenciador; os nós devem utilizar portas diferentes, como `5001`, `5002` e `5003`.

## Exemplo de criação do anel

Crie o primeiro nó com:

```text
ID: 8
IP: 127.0.0.1
Porta: 5001
Modo: Criar um novo anel
```

Em seguida, crie o nó `20`:

```text
ID: 20
IP: 127.0.0.1
Porta: 5002
Modo: Entrar por um nó existente

Nó de entrada:
ID: 8
IP: 127.0.0.1
Porta: 5001
```

Um terceiro nó pode ser criado com ID `28` e porta `5003`, entrando pelo mesmo nó `8`.

No gerenciador, o botão **Abrir painel** acessa a interface individual de cada nó. Por exemplo, `http://127.0.0.1:5001`. O estado desse nó também pode ser consultado em `http://127.0.0.1:5001/api/state`.

## Formação e roteamento do anel

O primeiro nó aponta seu predecessor, sucessor e todas as fingers para ele próprio. Quando outro nó executa `join`, ele usa o nó de entrada para localizar o sucessor de seu ID, conecta-se aos vizinhos encontrados e solicita a atualização das finger tables.

As cinco fingers de um nó `n` começam nas posições:

```text
n + 1, n + 2, n + 4, n + 8, n + 16
```

Cada entrada aponta para o primeiro nó ativo igual ou posterior à posição calculada. A finger table é uma tabela de roteamento e, por isso, não precisa listar todos os nós da rede.

## Distribuição dos arquivos

O nome do arquivo passa por SHA-256 e é convertido para uma posição entre `1` e `32`. O proprietário é o primeiro nó ativo encontrado a partir dessa posição.

Considere o anel:

```text
8 → 20 → 28 → 8
```

Se o nome de um arquivo resultar na posição `17`, o nó `20` será o proprietário. O nó utilizado para fazer o upload funciona apenas como ponto de entrada e não precisa ser o responsável pelo armazenamento.

## Estratégia de replicação

Depois de armazenar o original, o proprietário envia réplicas para seus dois sucessores consecutivos. Com o proprietário no nó `20`, a distribuição do exemplo anterior seria:

```text
Nó 20: arquivo original
Nó 28: primeira réplica
Nó 8:  segunda réplica
```

| Nós ativos | Originais | Réplicas | Cópias totais |
|---:|---:|---:|---:|
| 1 | 1 | 0 | 1 |
| 2 | 1 | 1 | 2 |
| 3 ou mais | 1 | 2 | 3 |

As réplicas não continuam propagando o arquivo. Somente o proprietário envia as duas cópias. Antes de atualizar uma réplica, o conteúdo é comparado por SHA-256 para evitar uma transferência desnecessária.

Os originais e as réplicas ficam separados no disco:

```text
data/node-20-5002/arquivo.txt
data/node-28-5003-replica/owner-20/arquivo.txt
data/node-8-5001-replica/owner-20/arquivo.txt
```

## Catálogo distribuído

O arquivo interno `catalogo.txt` mantém um nome por linha e permite que os painéis listem os arquivos disponíveis. Ele também passa pelo Chord, possui proprietário e recebe réplicas.

Antes do primeiro upload, o catálogo ainda não existe e o painel apresenta uma lista vazia. Ele é criado automaticamente quando o primeiro arquivo é inserido.

## Inserção e recuperação

Pela interface, abra o painel de qualquer nó, escolha um arquivo e clique em **Fazer upload**. O resultado mostra o hash, o proprietário e os destinos das réplicas.

Para recuperar, abra o painel de qualquer nó e clique no nome exibido no catálogo. O pedido será roteado até o proprietário. Se ele estiver indisponível, o sistema procura uma réplica e informa qual nó entregou o conteúdo.

As mesmas operações podem ser realizadas por HTTP:

```bash
curl -X POST http://127.0.0.1:5001/api/files \
  -H "content-type: application/json" \
  -d '{"name":"trabalho.txt","content":"conteúdo de exemplo"}'

curl -OJ "http://127.0.0.1:5002/api/files?name=trabalho.txt"
```

Arquivos binários devem ser enviados em Base64 com `"encoding":"base64"`.

## Execução em computadores diferentes

Cada máquina deve iniciar seu próprio gerenciador e anunciar um endereço IPv4 acessível pela rede local. Não anuncie `127.0.0.1` para outros computadores, pois esse endereço sempre representa a própria máquina.

Exemplo:

```text
Máquina A: 192.168.1.10:5001
Máquina B: 192.168.1.20:5001
```

Na máquina A, crie o anel. Na máquina B, selecione **Entrar por um nó existente** e informe o IP, o ID e a porta do nó da máquina A.

As portas do gerenciador e dos nós precisam estar liberadas no firewall. Teste a comunicação a partir de outro computador:

```bash
curl http://192.168.1.10:5001/api/state
```

## Testes automatizados

Execute:

```bash
npm test
```

Ou, no PowerShell:

```powershell
npm.cmd test
```

A suíte verifica aritmética circular, intervalos do anel, criação de nós, hash, inserção, recuperação, catálogo vazio, segurança dos nomes, escolha dos sucessores de replicação, roteamento por HTTP, saída graciosa e recuperação após falha abrupta.

## Sequência sugerida para demonstração

1. Execute os testes e mostre que todos foram aprovados.
2. Inicie o gerenciador e crie os nós `8`, `20` e `28`.
3. Abra o painel do nó `8` e mostre seu predecessor, sucessor e finger table.
4. Envie um arquivo pelo nó `8`.
5. Mostre que o proprietário foi escolhido pelo hash, independentemente do nó de entrada.
6. Mostre os dois cartões de réplica e os respectivos endereços.
7. Abra o painel de outro nó e recupere o mesmo arquivo pelo catálogo.
8. Abra o arquivo baixado para confirmar que o conteúdo foi preservado.
9. Opcionalmente, desligue um nó pelo gerenciador para mostrar a transferência dos arquivos e a reorganização do anel.

Durante a demonstração, destaque que a busca pode entrar por qualquer participante, enquanto o armazenamento é decidido pelo hash e a disponibilidade é aumentada pelas duas réplicas nos sucessores.

# Visual do Kamurafox

**Uma frase:** o visual da casa, o mesmo do Kamurafy e do Moneysniper: caderno de cartum, com papel claro, tinta preta grossa, sombra dura deslocada, amarelo-ouro de destaque e uma raposa de mascote.

Fechado em 03/10/2026. Os valores vieram do guia do Kamurafy (`docs/design.md` e `ui/css/base.css` daquele projeto), lidos nesse mesmo dia. Não há tema escuro: a casa é papel claro, e o popup fica claro mesmo com o Firefox no tema escuro.

## O que é da casa e ficou igual

| Peça | Valor |
|---|---|
| Tinta | `#000` |
| Texto de apoio | `#374151` |
| Papel (fundo) | `#fffdf8` |
| Cartão | `#fff` |
| Área neutra | `#f5f3ee` |
| Ouro (destaque) e ouro claro | `#ffd23f` e `#fff1b8` |
| Rosa (bochecha do mascote) | `#ff9eb5` |
| Situação boa e crítica | `#0ca30c` sobre `#dcf5dc`, `#d03b3b` sobre `#fadcdc` |
| Borda | 3 px de tinta |
| Sombra | dura, sem desfoque: 4 px (botão, cartão) e 2 px (figurinha, botão pequeno) |
| Cantos | 20 px no cartão, 12 px no aviso, 10 px na figurinha, 999 px em botão e situação |
| Botão | `.btn`: levanta 2 px ao passar o mouse, afunda 3 px ao clicar; `.gold`, `.ink` (preto com sombra ouro), `.small` |
| Situação | `.status`: sempre ícone + texto, nunca só a cor |
| Figurinha | `.sticker`: ouro, torta 3 graus, um fato só |
| Ícones | grade de 24, linha de 2,3, pontas redondas, `currentColor` |
| Curvas de movimento | `cubic-bezier(.22, 1, .36, 1)` e o pulo `cubic-bezier(.34, 1.56, .64, 1)` |
| Fonte | Fredoka, pesos 500 e 600. A More Sugar é de uso pessoal e não entra em nada publicado |

## O que é daqui

- **A raposa** (`extension/icons/kamurafox.svg`): cabeça de frente, ouro, contorno de tinta de 6 em 96, orelha com miolo preto, máscara branca, bochecha rosa, nariz preto. Ouro em vez de laranja para não lembrar a raposa do Firefox.
- **A marca na aba dirigida** (`LOOK` em `extension/content.js`): moldura de tinta de 3 px com fio de ouro por dentro, e uma figurinha no canto de baixo à esquerda com uma bolinha verde de "ao vivo" e o texto "Claude Code está dirigindo esta aba". Canto de baixo porque no topo ficam o menu, a busca e os botões dos sites.
- **O plop do clique**: uma bolinha de ouro com contorno de tinta que pula e some em meio segundo, no ponto onde o agente clicou.
- **Fonte dentro da página dos outros**: nada é baixado ali. Usa a letra arredondada do sistema (`ui-rounded`, SF Pro Rounded, Arial Rounded MT Bold) e, na falta, a do sistema. O estilo é aplicado direto no elemento, sem folha de estilo, para valer também em sites com política de segurança rígida.

## Voz

Português do Brasil e inglês, tom de amigo que entende do assunto: direto, sem prometer milagre.

- botão principal: "Pausar controle", e pausado "Retomar controle"
- cada aba da lista: "soltar"
- lista vazia: "Nenhuma agora. Peça algo ao Claude Code."
- sem ponte: "Rode o instalador na pasta do projeto: node install.js."
- pausado: "Pausado: o Claude Code não mexe no Firefox."

## Movimento

O cartão entra com um pulo curto ao abrir o popup, o botão levanta e afunda, o clique do agente faz o plop. Tudo isso desliga com "reduzir movimento".

## Não fazer

- Laranja, terracota ou roxo: lembram a Mozilla, a Anthropic e o resto das extensões de IA.
- Moldura pulsando, brilho, faísca, robô.
- Tema escuro só trocando o fundo.
- Usar a More Sugar ou o fundo de rabiscos do Moneysniper (foi gerado a partir dela).

## Licenças

Fredoka: SIL Open Font License 1.1, texto em `extension/fonts/Fredoka-OFL.txt`.

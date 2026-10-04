# Material para a loja do Firefox (addons.mozilla.org)

Tudo o que o formulário de envio pede, pronto para colar. O envio em si depende da conta Mozilla do dono.

## Dados básicos

- **Nome:** Kamurafox
- **Categoria:** Web Development (segunda opção: Tabs)
- **Licença:** GNU General Public License v3.0
- **Página do projeto e suporte:** https://github.com/GabrielKamura/kamurafox (dúvidas e defeitos em /issues)
- **Capturas:** `docs/img/aba-dirigida.jpg` e `docs/img/popup-en.png`

## Resumo (até 250 caracteres)

**Inglês:** Lets Claude Code on your computer drive Firefox tabs: open, click, type, read pages and take screenshots. Needs the local bridge from the project page. Unofficial: not made by Anthropic or Mozilla.

**Português:** Deixa o Claude Code do seu computador dirigir abas do Firefox: abrir, clicar, digitar, ler páginas e tirar print. Precisa da ponte local que está na página do projeto. Não oficial: não é da Anthropic nem da Mozilla.

## Descrição

**Inglês**

Kamurafox connects Firefox to Claude Code, the coding agent that runs in your terminal. Once it is installed, Claude Code can open a tab, go to a page, read it, click, type, fill forms, take screenshots and read the console and network log of that tab, so it can check its own work in a real browser.

How it works: the extension talks to a small program on your computer (a native messaging host), and Claude Code talks to that program through an MCP server. Nothing goes over the network; the conversation between Claude Code and Firefox stays on your machine.

You stay in charge:
- Claude Code only acts in tabs it opened, or in tabs you told it to take over. They sit in a "Claude" tab group and wear a black and gold frame with a sticker saying "Claude Code is driving this tab".
- The toolbar button lists the tabs under control, releases any of them and has a Pause control button that cuts everything off at once.

Setup: this extension does nothing on its own. Install the bridge from the project page (one command: node install.js) and open a new Claude Code session.

Limits: Firefox does not give extensions a debugger, so mouse and keyboard are synthetic page events. Native select menus, file pickers, the clipboard and content inside iframes are out of reach. Firefox itself blocks extensions on about: pages, addons.mozilla.org, the PDF viewer and reader view.

Unofficial project. Not made, endorsed or supported by Anthropic or Mozilla. Source code under GPL-3.0.

**Português**

O Kamurafox liga o Firefox ao Claude Code, o agente de programação que roda no terminal. Com ele instalado, o Claude Code abre uma aba, vai a uma página, lê, clica, digita, preenche formulário, tira print e lê o console e a rede daquela aba, para conferir o próprio trabalho num navegador de verdade.

Como funciona: a extensão conversa com um programa pequeno no seu computador, e o Claude Code conversa com esse programa por um servidor MCP. Nada passa pela rede; a conversa entre o Claude Code e o Firefox fica na sua máquina.

Quem manda é você:
- O Claude Code só age nas abas que ele abriu, ou nas que você mandou assumir. Elas ficam num grupo "Claude" e ganham uma moldura preta e amarela com a figurinha "Claude Code está dirigindo esta aba".
- O botão da extensão lista as abas sob controle, solta qualquer uma e tem o Pausar controle, que corta tudo na hora.

Instalação: sozinha, a extensão não faz nada. Instale a ponte pela página do projeto (um comando: node install.js) e abra uma sessão nova do Claude Code.

Limites: o Firefox não dá depurador a extensões, então mouse e teclado são eventos sintéticos da página. Menu nativo de lista, seletor de arquivo, área de transferência e conteúdo dentro de iframes ficam de fora. O próprio Firefox bloqueia extensões em páginas about:, em addons.mozilla.org, no leitor de PDF e no modo leitura.

Projeto não oficial. Não é feito, endossado nem suportado pela Anthropic ou pela Mozilla. Código aberto sob GPL-3.0.

## Política de privacidade

**Inglês**

Kamurafox has no server, no account and no analytics. It sends nothing to its author.

When Claude Code asks for it, the extension reads the tabs under its control (the ones Claude Code opened or you told it to take over): page text and structure, screenshots, the address and title, console messages and the list of network requests. That data goes only to the Kamurafox program running on your own computer, which hands it to your Claude Code session. What Claude Code does with it, including sending it to Anthropic to get an answer, is governed by your Claude Code settings and Anthropic's privacy policy.

Tabs that are not under control are not read. While at least one tab is under control, a tiny script runs at the start of each page in other tabs only to ask the extension whether that tab is controlled; if it is not, the script removes itself without reading anything.

The only thing stored in Firefox is whether control is paused.

**Português**

O Kamurafox não tem servidor, conta nem medição de uso. Não manda nada para o autor.

Quando o Claude Code pede, a extensão lê as abas sob controle (as que o Claude Code abriu ou as que você mandou assumir): texto e estrutura da página, prints, endereço e título, mensagens do console e a lista de requisições de rede. Esses dados vão só para o programa do Kamurafox que roda no seu próprio computador, que entrega à sua sessão do Claude Code. O que o Claude Code faz com eles, inclusive enviar à Anthropic para obter a resposta, segue as configurações do seu Claude Code e a política de privacidade da Anthropic.

Abas fora de controle não são lidas. Enquanto houver ao menos uma aba sob controle, um script mínimo roda no começo de cada página das outras abas só para perguntar à extensão se aquela aba é controlada; se não for, ele se desfaz sem ler nada.

A única coisa guardada no Firefox é se o controle está pausado.

## Notas para o revisor (em inglês)

- The package is the source: plain JavaScript, no build step, no minification, no bundled libraries. Repository: https://github.com/GabrielKamura/kamurafox
- The extension needs a native messaging host named `kamurafox`. To test: clone the repository, run `node install.js` (copies the bridge to ~/.kamurafox and registers the host), then run `npm test`, which drives a real Firefox through every tool. Without the host the popup shows "bridge offline" and the extension is idle.
- `<all_urls>`: the user's agent may be asked to work on any site. Page scripts (`content.js`) are injected only into tabs under control, through `tabs.executeScript`.
- `early.js` is registered with `contentScripts.register` only while at least one tab is under control. It wraps `console` at document start, asks the background whether its tab is controlled and, if not, restores `console` and removes itself. This is needed because a script injected after `webNavigation.onCommitted` misses the page's first console output.
- `webRequest` (non-blocking) lists finished requests of controlled tabs, with one listener per controlled tab.
- `javascript_tool` evaluates code in a controlled tab (`window.eval`, or `tabs.executeScript` with a code string where the page's CSP forbids eval). The code comes from the user's own local Claude Code session over native messaging. The extension never downloads or runs code from a server.
- Data collection declared in the manifest: `websiteContent` and `browsingActivity`, for the controlled tabs, transmitted to the local native application only.
- The Fredoka font files are under the SIL Open Font License (extension/fonts/Fredoka-OFL.txt).

## Antes de enviar

1. Entrar em addons.mozilla.org com a conta Mozilla e aceitar o acordo de distribuição.
2. Gerar a chave em Ferramentas › Gerenciar chaves de API e colar em `.amo/credenciais.env`.
3. `npm run sign` assina a versão atual no canal não listado (instalação direta, sem aparecer na loja).
4. Para aparecer na loja: subir a versão no `manifest.json` e enviar pelo site, no canal listado, com os textos e as capturas acima. A revisão pode questionar a ferramenta de JavaScript; a resposta está nas notas para o revisor.

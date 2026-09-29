/**
 * Fluxo de Artes TNT 2.0 - gerador automatico de PDF direto do site.
 * Abre https://lucasbitto.github.io/LogCoberturas/ em um navegador
 * headless, dispara o mesmo botao "PDF do dia" / "PDF do mes" da pagina
 * e salva o resultado em ./saida com a data no nome do arquivo.
 *
 * Uso:  node gerar-pdf.js dia     -> Fluxo-Artes_DIA_AAAA-MM-DD.pdf
 *       node gerar-pdf.js mes     -> Fluxo-Artes_MES_AAAA-MM.pdf
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SITE = process.env.SITE_URL || 'https://lucasbitto.github.io/LogCoberturas/';
const TZ = 'America/Sao_Paulo';
const MODO = (process.argv[2] || 'dia').toLowerCase();
const DATA_FORCADA = (process.env.DATA_ALVO || '').trim();   // opcional: AAAA-MM-DD ou AAAA-MM
const SAIDA = path.join(__dirname, 'saida');

function hojeBR() {
  // AAAA-MM-DD no fuso de Sao Paulo, independente do fuso do runner
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function mesAnterior() {
  const [a, m] = hojeBR().split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

(async () => {
  const dia = (MODO === 'dia' && /^\d{4}-\d{2}-\d{2}$/.test(DATA_FORCADA)) ? DATA_FORCADA : hojeBR();
  const mes = MODO === 'mes'
    ? (/^\d{4}-\d{2}$/.test(DATA_FORCADA) ? DATA_FORCADA : mesAnterior())
    : dia.slice(0, 7);
  const nome = MODO === 'mes'
    ? `Fluxo-Artes_MES_${mes}.pdf`
    : `Fluxo-Artes_DIA_${dia}.pdf`;

  fs.mkdirSync(SAIDA, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 });
  // O site chama window.print(); neutralizamos para capturar o PDF nos.
  await page.evaluateOnNewDocument(() => { window.print = () => { window.__printOk = true; }; });
  await page.emulateTimezone(TZ);

  // Tudo que a pagina reclamar aparece no log do robo
  const errosPagina = [];
  page.on('pageerror', e => errosPagina.push('JS: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errosPagina.push('console: ' + m.text().slice(0, 200)); });
  page.on('requestfailed', r => errosPagina.push('rede: ' + r.url().slice(0, 90) + ' -> ' + (r.failure() || {}).errorText));

  console.log('Abrindo', SITE);
  await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 120000 });

  // Espera o app existir de fato (o HTML pode chegar antes do script rodar)
  await page.waitForFunction(
    () => document.getElementById('printDay') && typeof window.printDailyReport === 'function',
    { timeout: 60000 }
  ).catch(() => {});

  // Espera a sincronizacao com a planilha terminar
  await page.waitForFunction(
    () => {
      const s = document.getElementById('sync');
      return s && /sincronizado/i.test(s.textContent || '');
    },
    { timeout: 120000 }
  ).catch(() => console.warn('Aviso: status de sincronizacao nao confirmado, seguindo mesmo assim.'));
  await new Promise(r => setTimeout(r, 4000));

  // Abre a aba de relatorios (o PDF e montado a partir dela)
  await page.evaluate(() => {
    const alvo = [...document.querySelectorAll('.chip,.btn,[data-view],[onclick]')]
      .find(b => /relat/i.test(b.textContent || ''));
    if (alvo) alvo.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // Diagnostico: o que o site realmente carregou
  const diag = await page.evaluate(() => ({
    titulo: document.title,
    sync: (document.getElementById('sync') || {}).textContent || '',
    temBotaoDia: !!document.getElementById('printDay'),
    temFuncaoDia: typeof window.printDailyReport === 'function',
    temAbaRelatorios: !!document.getElementById('reportsView'),
    configAberta: !!(document.getElementById('config') &&
                     !document.getElementById('config').classList.contains('hidden')),
    artes: (function () {
      try { var c = JSON.parse(localStorage.getItem('tnt_items_cache') || '[]');
            if (Array.isArray(c) && c.length) return c.length; } catch (e) {}
      return (window.items || []).length;
    })(),
    meses: [...((document.getElementById('month') || {}).options || [])].map(o => o.value),
    dias: [...document.querySelectorAll('[id^="d20"]')].map(e => e.id.slice(1))
  }));
  console.log('Pagina:', diag.titulo);
  console.log('Sincronizacao:', diag.sync || '(sem status)');
  console.log('Artes carregadas:', diag.artes);
  console.log('Meses disponiveis no relatorio:', diag.meses.join(', ') || '(nenhum)');
  if (errosPagina.length) {
    console.log('--- a pagina reclamou disto ---');
    [...new Set(errosPagina)].slice(0, 8).forEach(e => console.log('  ' + e));
  }
  if (diag.configAberta) {
    throw new Error('O site abriu na tela de Configuracao: o endereco do Apps Script nao esta salvo. ' +
                    'Abra o site, va em Config. e salve a URL que termina em /exec.');
  }
  if (!diag.temBotaoDia && !diag.temFuncaoDia) {
    throw new Error('A pagina carregou mas nao tem os controles de relatorio (titulo: "' + diag.titulo + '"). ' +
                    'Confirme se o index.html publicado no GitHub Pages e a versao atual.');
  }

  const mesAlvo = MODO === 'mes' ? mes : dia.slice(0, 7);
  if (diag.meses.length && !diag.meses.includes(mesAlvo)) {
    console.log(`SEM DADOS: nao ha nenhuma arte lancada em ${mesAlvo}. Nada a gerar hoje.`);
    await browser.close();
    process.exit(0);
  }

  // Seleciona o periodo e redesenha o relatorio
  await page.evaluate((modo, dia, mesAlvo) => {
    const sel = document.getElementById('month');
    if (sel && [...sel.options].some(o => o.value === mesAlvo)) {
      sel.value = mesAlvo;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const inp = document.getElementById('date');
    if (inp && modo === 'dia') {
      inp.value = dia;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof window.renderReports === 'function') window.renderReports();
  }, MODO, dia, mesAlvo);
  await new Promise(r => setTimeout(r, 2500));

  if (MODO === 'dia') {
    const temDia = await page.evaluate(d => !!document.getElementById('d' + d.replaceAll('-', '')), dia);
    if (!temDia && !diag.artes) {
      console.log('SEM DADOS: o site nao carregou nenhuma arte. Verifique se o Apps Script esta publicado');
      console.log('como NOVA VERSAO e respondendo. Nada a gerar.');
      await browser.close();
      process.exit(0);
    }
    if (!temDia) {
      const dias = await page.evaluate(() =>
        [...document.querySelectorAll('[id^="d20"]')].map(e => e.id.slice(1)).sort().reverse());
      const legivel = dias.map(x => `${x.slice(6)}/${x.slice(4, 6)}/${x.slice(0, 4)}`);
      console.log(`SEM DADOS: nenhuma arte lancada em ${dia}.`);
      console.log('Ultimos dias com producao:', legivel.slice(0, 5).join(', ') || '(nenhum)');
      await browser.close();
      process.exit(0);
    }
  }

  // Captura os avisos (toast) do proprio site, para aparecerem no log
  await page.evaluate(() => {
    window.__avisos = [];
    if (typeof window.toast === 'function') {
      const orig = window.toast;
      window.toast = m => { window.__avisos.push(String(m)); return orig(m); };
    }
  });

  const ok = await page.evaluate((modo, dia) => {
    if (modo === 'mes') {
      const b = document.getElementById('printMonth');
      if (!b) return 'botao do mes nao encontrado';
      b.click();
    } else if (typeof window.printDailyReport === 'function') {
      window.printDailyReport(dia);
    } else {
      const b = document.getElementById('printDay');
      if (!b) return 'botao do dia nao encontrado';
      b.click();
    }
    return 'ok';
  }, MODO, dia);

  if (ok !== 'ok') throw new Error('Nao foi possivel disparar a geracao: ' + ok);

  // Da tempo para o layout de impressao ser montado
  await new Promise(r => setTimeout(r, 6000));

  const temConteudo = await page.evaluate(() =>
    document.body.classList.contains('print-day') || document.body.classList.contains('print-month'));
  if (!temConteudo) {
    const avisos = await page.evaluate(() => (window.__avisos || []).join(' | '));
    throw new Error('O site nao entrou em modo de impressao. Aviso do site: ' + (avisos || '(nenhum)'));
  }

  const destino = path.join(SAIDA, nome);
  await page.pdf({
    path: destino,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' }
  });
  await browser.close();

  const kb = Math.round(fs.statSync(destino).size / 1024);
  console.log(`PDF gerado: ${nome} (${kb} KB)`);
  // Informacoes para o passo de upload
  const pasta = MODO === 'mes'
    ? `Fluxo de Artes TNT - Relatorios/Mensal/${mes.slice(0, 4)}`
    : `Fluxo de Artes TNT - Relatorios/Diario/${dia.slice(0, 7)}`;
  fs.writeFileSync(path.join(SAIDA, 'destino.json'), JSON.stringify({ arquivo: nome, pasta }, null, 2));
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

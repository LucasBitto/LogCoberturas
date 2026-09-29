/**
 * REVISAO DE PDFs - Log de Coberturas
 * ----------------------------------------------------------
 * Abre o site, calcula uma "impressao digital" de cada dia
 * recente (artes + janela de cobertura) e compara com o que ja
 * foi gerado antes. Manda regerar o PDF apenas dos dias que:
 *   - mudaram depois do PDF ter sido feito, ou
 *   - nunca chegaram a ser gerados.
 *
 * O historico fica em scripts/estado-pdfs.json, versionado no
 * proprio repositorio.
 *
 * Uso:  node scripts/revisar-dias.js [quantos_dias]
 *       (padrao: 30 dias para tras)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

const SITE = process.env.SITE_URL || 'https://lucasbitto.github.io/LogCoberturas/';
const TZ = 'America/Sao_Paulo';
const DIAS = parseInt(process.argv[2] || process.env.DIAS_REVISAO || '30', 10);
const MAX_POR_RODADA = parseInt(process.env.MAX_POR_RODADA || '8', 10);
const ESTADO = path.join(__dirname, 'estado-pdfs.json');

const hojeBR = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function carregarEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); }
  catch (_) { return { dias: {} }; }
}

function digital(artes, janela) {
  // tudo que, mudando, justifica refazer o PDF
  const base = artes
    .map(a => [a.id, a.title, a.designer, a.status, a.requestedAt, a.finishedAt,
               a.adjustedAt || '', a.carousel || 0, (a.categories || []).join('+'),
               a.priority || '', a.notes || ''].join('~'))
    .sort()
    .join('\n');
  const j = janela
    ? [janela.startTime, janela.endTime, janela.openedBy, janela.closedBy, janela.obs].join('~')
    : '';
  return crypto.createHash('sha1').update(base + '||' + j).digest('hex').slice(0, 16);
}

(async () => {
  const estado = carregarEstado();
  const hoje = hojeBR();
  const limite = new Date(hoje + 'T12:00:00Z');
  limite.setUTCDate(limite.getUTCDate() - (DIAS - 1));
  const inicio = limite.toISOString().slice(0, 10);

  console.log(`Revisando de ${inicio} ate ${hoje} (${DIAS} dias).`);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.emulateTimezone(TZ);
  await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 120000 });
  // O app guarda a lista em variavel interna (nao visivel de fora), mas
  // mantem uma copia no armazenamento local. E de la que lemos.
  const temDados = () => {
    try {
      const c = JSON.parse(localStorage.getItem('tnt_items_cache') || '[]');
      return Array.isArray(c) && c.length > 0;
    } catch (_) { return false; }
  };
  await page.waitForFunction(temDados, { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const dados = await page.evaluate(() => {
    let lista = [];
    try { lista = JSON.parse(localStorage.getItem('tnt_items_cache') || '[]'); } catch (_) {}
    if (!Array.isArray(lista) || !lista.length) {
      if (Array.isArray(window.items)) lista = window.items;          // reserva
    }
    // as janelas tambem saem da tela de relatorios, quando disponiveis
    let janelas = {};
    try { janelas = window.coverageWindows || {}; } catch (_) {}
    return {
      artes: (lista || []).map(x => ({
        id: x.id, date: x.date, requestedAt: x.requestedAt, title: x.title,
        designer: x.designer, status: x.status, finishedAt: x.finishedAt,
        adjustedAt: x.adjustedAt || '', carousel: x.carousel || 0,
        categories: x.categories || [], priority: x.priority || '', notes: x.notes || ''
      })),
      janelas: janelas,
      sync: (document.getElementById('sync') || {}).textContent || '',
      configAberta: !!(document.getElementById('config') &&
                       !document.getElementById('config').classList.contains('hidden'))
    };
  });
  await browser.close();

  if (!dados.artes.length) {
    console.log('O site nao devolveu nenhuma arte. Nada a revisar nesta rodada.');
    console.log('  status de sincronizacao: ' + (dados.sync || '(sem status)'));
    if (dados.configAberta) {
      console.log('  o site abriu na tela de Configuracao: falta salvar a URL do Apps Script.');
    } else {
      console.log('  verifique se o Apps Script esta publicado como NOVA VERSAO e respondendo.');
    }
    process.exit(0);
  }
  console.log(`Artes lidas do site: ${dados.artes.length}`);

  // mesma regra do app: pedido antes das 01h conta para o dia anterior
  const diaOperacional = x => {
    if (!x.date) return '';
    const [a, m, d] = String(x.date).slice(0, 10).split('-').map(Number);
    const dt = new Date(Date.UTC(a, m - 1, d, 12));
    const h = parseInt(String(x.requestedAt || '00:00').slice(0, 2), 10) || 0;
    if (h < 1) dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  };

  const porDia = {};
  dados.artes.forEach(x => {
    const d = diaOperacional(x);
    if (d >= inicio && d <= hoje) (porDia[d] ??= []).push(x);
  });

  const pendentes = [];
  Object.keys(porDia).sort().forEach(d => {
    const atual = digital(porDia[d], dados.janelas[d]);
    const antes = estado.dias[d];
    if (!antes) pendentes.push({ dia: d, motivo: 'nunca gerado', hash: atual });
    else if (antes.hash !== atual) pendentes.push({ dia: d, motivo: 'alterado depois do PDF', hash: atual });
  });

  // Usado logo apos a geracao do dia: apenas registra o estado atual,
  // para a revisao seguinte nao refazer um PDF que acabou de sair.
  if (process.env.MARCAR_SEM_GERAR === '1') {
    pendentes.forEach(p => { estado.dias[p.dia] = { hash: p.hash, em: new Date().toISOString() }; });
    estado.revisadoEm = new Date().toISOString();
    fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 2));
    console.log(`Historico atualizado para ${pendentes.length} dia(s), sem gerar nada.`);
    process.exit(0);
  }

  if (!pendentes.length) {
    console.log('Tudo em dia: nenhum PDF precisa ser refeito.');
    process.exit(0);
  }

  console.log(`\n${pendentes.length} dia(s) para refazer:`);
  pendentes.forEach(p => console.log(`  ${p.dia} - ${p.motivo}`));

  const lote = pendentes.slice(0, MAX_POR_RODADA);
  if (lote.length < pendentes.length) {
    console.log(`Fazendo ${lote.length} agora; o resto entra na proxima revisao.`);
  }

  let feitos = 0;
  for (const p of lote) {
    console.log(`\n--- ${p.dia} ---`);
    try {
      execFileSync('node', [path.join(__dirname, 'gerar-pdf.js'), 'dia'], {
        stdio: 'inherit',
        env: { ...process.env, DATA_ALVO: p.dia, SITE_URL: SITE, REVISAO: '1' }
      });
      const marca = path.join(__dirname, 'saida', 'destino.json');
      if (!fs.existsSync(marca)) { console.log('  (sem PDF gerado; pulando)'); continue; }
      execFileSync('node', [path.join(__dirname, 'enviar-email.js')], {
        stdio: 'inherit',
        env: { ...process.env, REVISAO: '1' }
      });
      estado.dias[p.dia] = { hash: p.hash, em: new Date().toISOString() };
      feitos++;
      fs.rmSync(marca, { force: true });
    } catch (e) {
      console.log(`  FALHOU em ${p.dia}: ${e.message.split('\n')[0]}`);
    }
  }

  estado.revisadoEm = new Date().toISOString();
  fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 2));
  console.log(`\nResumo: ${feitos} PDF(s) refeito(s) e reenviado(s).`);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

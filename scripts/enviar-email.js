/**
 * Envia o PDF gerado por gerar-pdf.js para a ponte no Apps Script,
 * que o entrega por e-mail no Outlook (de onde o Copilot arquiva
 * no OneDrive, nas pastas Diario/AAAA-MM e Mensal/AAAA).
 *
 * Segredos no repositorio: RELAY_URL, RELAY_TOKEN
 */
const fs = require('fs');
const path = require('path');

const SAIDA = path.join(__dirname, 'saida');
const destinoJson = path.join(SAIDA, 'destino.json');

if (!fs.existsSync(destinoJson)) {
  console.log('Nenhum PDF foi gerado nesta execucao (dia sem artes). Nada a enviar.');
  process.exit(0);
}
if (!process.env.RELAY_URL || !process.env.RELAY_TOKEN) {
  console.log('Segredos RELAY_URL / RELAY_TOKEN ausentes. O PDF continua nos artefatos.');
  process.exit(0);
}

const { arquivo, pasta } = JSON.parse(fs.readFileSync(destinoJson, 'utf8'));
const ehMes = /_MES_/.test(arquivo);
const periodo = arquivo.replace(/^Fluxo-Artes_(DIA|MES)_/, '').replace(/\.pdf$/, '');
const revisao = process.env.REVISAO === '1';
const assunto = (ehMes ? '[FLUXO-PDF][MES] ' : '[FLUXO-PDF][DIA] ') + periodo + (revisao ? ' [REVISAO]' : '');

(async () => {
  const pdf = fs.readFileSync(path.join(SAIDA, arquivo)).toString('base64');
  const r = await fetch(process.env.RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: process.env.RELAY_TOKEN,
      nome: arquivo,
      assunto: assunto,
      corpo: (revisao
        ? 'RELATORIO REFEITO: este dia foi editado depois do PDF anterior. '
          + 'Substitua o arquivo de mesmo nome que ja estiver na pasta.\n'
        : 'Relatorio gerado automaticamente a partir do site.\n')
        + 'Pasta de destino: ' + pasta,
      pdf: pdf
    })
  });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (_) {
    throw new Error('Resposta inesperada da ponte (HTTP ' + r.status + '): ' + txt.slice(0, 300));
  }
  if (!j.ok) throw new Error('A ponte recusou o envio: ' + (j.erro || txt.slice(0, 200)));
  console.log('PDF enviado pela ponte: ' + arquivo);
  console.log('Assunto: ' + assunto + '  |  Pasta de destino: ' + pasta);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

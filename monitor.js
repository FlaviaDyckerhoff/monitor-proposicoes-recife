const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'https://e-processo.recife.pe.leg.br/@@materias';

// Todos os tipos de matéria cadastrados na Câmara do Recife
const TIPOS = [
  { id: '30', title: 'Aditamento a Parecer' },
  { id: '15', title: 'Emenda a Projeto de Lei do Executivo' },
  { id: '6',  title: 'Projeto de Decreto Legislativo' },
  { id: '14', title: 'Projeto de Emenda à Lei Orgânica' },
  { id: '28', title: 'Projeto de Lei Complementar' },
  { id: '11', title: 'Projeto de Lei do Executivo' },
  { id: '10', title: 'Projeto de Lei Ordinária' },
  { id: '2',  title: 'Projeto de Resolução' },
  { id: '23', title: 'Proposta de Revisão à Lei Orgânica' },
  { id: '3',  title: 'Requerimento' },
  { id: '27', title: 'Veto' },
];

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function buscarPorTipo(tipo, ano) {
  const url = `${API_BASE}?ano=${ano}&tipo=${tipo.id}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) {
    console.warn(`⚠️ Erro ao buscar tipo ${tipo.title}: ${response.status}`);
    return [];
  }

  const json = await response.json();
  const items = json.items || [];
  console.log(`  ${tipo.title}: ${items.length} matéria(s)`);
  return items;
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando matérias de ${ano} em ${TIPOS.length} tipos (paralelo)...`);

  const resultados = await Promise.all(
    TIPOS.map(tipo => buscarPorTipo(tipo, ano))
  );

  // Achata e deduplica por ID (segurança contra duplicatas entre tipos)
  const porId = new Map();
  resultados.flat().forEach(item => {
    if (item.id && !porId.has(item.id)) {
      porId.set(item.id, item);
    }
  });

  const total = porId.size;
  console.log(`📊 Total único: ${total} matéria(s)`);
  return Array.from(porId.values());
}

function extrairTitulo(titleStr) {
  // "Requerimento nº 2437/2026" → tipo: "Requerimento", numero: "2437", ano: "2026"
  const match = titleStr.match(/^(.+?)\s+nº\s+(\d+)\/(\d{4})$/);
  if (match) {
    return { tipo: match[1].trim(), numero: match[2], ano: match[3] };
  }
  // Fallback: tenta separar pelo "nº" sem regex estrita
  const partes = titleStr.split(' nº ');
  if (partes.length === 2) {
    const [num, ano] = partes[1].split('/');
    return { tipo: partes[0].trim(), numero: num, ano: ano || '-' };
  }
  return { tipo: titleStr, numero: '-', ano: '-' };
}

function normalizarProposicao(p) {
  const { tipo, numero, ano } = extrairTitulo(p.title || '');
  const autor = p.authorship && p.authorship.length > 0
    ? p.authorship[0].title
    : '-';

  return {
    id: String(p.id),
    tipo,
    numero,
    ano,
    autor,
    data: p.date || '-',
    ementa: (p.description || '-').trim().substring(0, 250),
    url: p.remoteUrl || '',
  };
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo, ordena por número decrescente dentro de cada tipo
  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
    porTipo[p.tipo].push(p);
  });
  Object.values(porTipo).forEach(lista =>
    lista.sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
  );

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr>
      <td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">
        ${tipo} — ${porTipo[tipo].length} matéria(s)
      </td>
    </tr>`;
    const rows = porTipo[tipo].map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;white-space:nowrap">
          ${p.numero}/${p.ano}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          ${p.autor}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          ${p.data}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">
          ${p.ementa}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          ${p.url ? `<a href="${p.url}" style="color:#1a3a5c">Ver →</a>` : ''}
        </td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ Câmara do Recife — ${novas.length} nova(s) matéria(s)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
            <th style="padding:10px;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://e-processo.recife.pe.leg.br/consultas/materia/materia_index_html">
          e-processo.recife.pe.leg.br
        </a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Câmara Recife" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Câmara Recife: ${novas.length} nova(s) matéria(s) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} matéria(s) nova(s).`);
}

(async () => {
  console.log('🚀 Iniciando monitor Câmara Municipal do Recife...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  const raw = await buscarProposicoes();

  if (raw.length === 0) {
    console.log('⚠️ Nenhuma matéria encontrada. API pode estar fora do ar.');
    process.exit(0);
  }

  const proposicoes = raw.map(normalizarProposicao).filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Matérias novas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();

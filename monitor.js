const FICHA_URL = process.env.FICHA_URL || 'https://doe.monitorlegislativo.com.br/ficha';

function fichaEmailButtonHtml() {
  return '<div style="background:#eef6ff;border:1px solid #c7ddf2;border-radius:6px;padding:11px 13px;margin:12px 0;color:#173d63;font-size:13px;line-height:1.45">' +
    '<strong>Ficha</strong><br>' +
    '<span>Cole o link oficial de uma proposição para criar ficha e acelerar a revisão/cadastro.</span><br>' +
    '<a href="' + FICHA_URL + '" style="display:inline-block;background:#0f3d5c;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-weight:bold;margin-top:8px">Criar ficha</a>' +
    '</div>';
}

const fs = require('fs');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'PE - Recife';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

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
    ementa: (p.description || '-').trim(),
    url: p.remoteUrl || '',
  };
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra'
];

const CLIENTES_INATIVOS_NAO_DESTACAR = [
  'CVC', 'DIAGEO', 'Femsa', 'Lalamove', 'lalamove',
  'Maersk', 'Matrix', 'Rei do Pitaco', 'Sanofi', 'Syngenta',
  'Ypê', 'Ype', 'Braskem', 'Vital', 'Natural Energia',
  'Pacto Pela Fome', 'TikTok', 'Norte Energia', 'Mac Jee',
  'Solar', 'Grupo Simões', 'Grupo Simoes'
];

function clienteAtivoParaDestaque(nome) {
  return !CLIENTES_INATIVOS_NAO_DESTACAR.some(inativo => inativo.toLowerCase() === String(nome || '').toLowerCase());
}

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    if (!clienteAtivoParaDestaque(nome)) continue;
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return promoverInteresseClienteProposicao(p, achados, mlClientInterestContext());
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
      p.ementa = String(p.ementa).trim() + ' | 🆘 CLIENTE CITADO: ' + clientes.join(', ');
    }
  }
}

function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(valor) {
  return String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function destacarTermosCliente(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .filter(clienteAtivoParaDestaque)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return escapeHtml(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(escapeRegExp).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return escapeHtml(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmenta(p) {
  const texto = String(p.ementa || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = destacarTermosCliente(partes[0], p.clientesCitados);
  if (partes.length < 2) return ementa;

  const clientes = partes.slice(1).join(' | 🆘 CLIENTE CITADO: ');
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + destacarTermosCliente(clientes, p.clientesCitados) +
    '</span></div>';
}


function clientesCitadosResumoEmail(novas) {
  const vistos = new Set();
  const nomes = [];
  for (const p of (novas || [])) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      const key = String(nome).toLowerCase();
      if (!vistos.has(key)) { vistos.add(key); nomes.push(nome); }
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 Cliente citado: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;
  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;
  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PROJETO LEI': 'PL', 'PROJETO DE LEI ORDINARIA': 'PL', 'PLO': 'PL', 'PL': 'PL', 'PL - PROJETO DE LEI': 'PL', 'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI ORDINARIA': 'PLO', 'PLO': 'PLO',
    'PROJETO DE LEI DO EXECUTIVO': 'PLE', 'PLE': 'PLE',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC', 'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC', 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC', 'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL', 'PIL': 'PIL', 'PIL - PROJETO DE INDICACAO': 'PIL', 'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas, opts = {}) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = opts.onlyLatest ? [rec] : (rec.itens && rec.itens.length ? rec.itens : [rec]);
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item && !(det.id || det.link)) {
          item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === det.tipo);
        }
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data, expected_updated_at: state.updated_at || null, merge_casas: [CASA_RADAR03] }),
    });
    if (!postResp.ok) {
      const body = await postResp.text().catch(() => '');
      throw new Error('POST ' + postResp.status + (body ? ': ' + body.slice(0, 300) : ''));
    }
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
    return true;
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
    return false;
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  anotarClientesCitados(novas);
  const nodemailer = require('nodemailer');
let promoverInteresseClienteProposicao = (_item, atuais) => Array.isArray(atuais) ? atuais : [];
try {
  try {
    ({ promoverInteresseClienteProposicao } = require('./client_interest_matcher_js'));
  } catch (_localErr) {
    ({ promoverInteresseClienteProposicao } = require('../../agents/pautas/client_interest_matcher_js'));
  }
} catch (err) {
  console.warn('⚠️ Matcher cliente/palavra comum indisponível; usando destaque legado: ' + err.message);
}

function mlClientInterestContext() {
  return {
    uf: typeof CLIENT_INTEREST_UF !== 'undefined' ? CLIENT_INTEREST_UF : (process.env.CLIENT_INTEREST_UF || process.env.UF || ''),
    municipio: typeof CLIENT_INTEREST_MUNICIPIO !== 'undefined' ? CLIENT_INTEREST_MUNICIPIO : (process.env.CLIENT_INTEREST_MUNICIPIO || process.env.MUNICIPIO || ''),
    casa: typeof CASA_RADAR03 !== 'undefined' ? CASA_RADAR03 : (process.env.CASA_RADAR03 || process.env.CASA || ''),
  };
}

  anotarClientesCitados(novas);
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

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
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
          ${escapeHtml(p.autor)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          ${escapeHtml(p.data)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">
          ${renderizarEmenta(p)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          ${p.url ? `<a href="${p.url}" style="color:#1a3a5c">Ver →</a>` : ''}
        </td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ Câmara Municipal do Recife — ${novas.length} nova(s) matéria(s)
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
    from: `"Monitor Recife" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: assuntoEmailClienteCitado(novas, `🏛️ Recife: ${novas.length} nova(s) matéria(s) — ${new Date().toLocaleDateString('pt-BR')}`),
    html: fichaEmailButtonHtml() + html,
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

  const forceRadar03 = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
  if (forceRadar03) {
    const alvoRadar03 = novas.length ? novas : proposicoes;
    const sincronizou = await sincronizarRadar03(alvoRadar03, { onlyLatest: !novas.length });
    if (!sincronizou) {
      throw new Error('Controle 03 recusou a sincronização fora de hora');
    }
    console.log('✅ Radar 03 atualizado fora de hora com a lista atual da fonte. Email não enviado.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    return;
  }

  const radar03Set = novas;

  if (radar03Set.length > 0) {
    await sincronizarRadar03(radar03Set);
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

(function(){
"use strict";

/* ============================================================
   MDT TÁTICO — Autenticação e Sincronização (Supabase)
   Estratégia: local-first. O localStorage continua sendo a
   fonte de verdade para o app funcionar 100% offline. Este
   módulo só espelha os dados pra nuvem quando há conexão.
   ============================================================ */

const SUPABASE_URL_RAW = 'https://tvzxhyvmedrkuwkxlzpf.supabase.co/rest/v1/';
const SUPABASE_URL = SUPABASE_URL_RAW.replace(/\/rest\/v1\/?$/, ''); // o SDK quer só a URL base do projeto
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2enhoeXZtZWRya3V3a3hsenBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTMyMTIsImV4cCI6MjEwNDY2OTIxMn0.laQZ_haZk8jaYOdqvoAbB7IE73XdyU47vvMLx6qohBw';
const FOTOS_BUCKET = 'fotos-mdt';
const PENDING_KEY = 'mdt_pending_sync_v1';

if(!window.supabase){
  console.error('SDK do Supabase não carregou — verifique a conexão.');
}
const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUserId = null;

/* ---------------- Indicador visual de sincronização ---------------- */
const syncEl = document.getElementById('syncIndicator');
function setSyncStatus(state){
  syncEl.className = state;
  const map = { idle:['☁️','Sincronizado'], syncing:['🔄','Sincronizando...'], offline:['📴','Sem conexão — salvando só localmente'], error:['⚠️','Falha ao sincronizar — vai tentar de novo'] };
  const [emoji, title] = map[state] || map.idle;
  syncEl.textContent = emoji;
  syncEl.title = title;
}
setSyncStatus('offline');

/* ---------------- Fila de pendências (offline) ---------------- */
function loadQueue(){ try{ return JSON.parse(localStorage.getItem(PENDING_KEY)||'[]'); }catch(e){ return []; } }
function saveQueue(q){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify(q)); }catch(e){} }
function enqueue(action){
  const q = loadQueue();
  // substitui uma pendência anterior do mesmo registro (não empilha saves repetidos do mesmo item)
  const idx = q.findIndex(a=> a.type===action.type && a.table===action.table && a.id===action.id);
  if(idx>-1) q[idx] = action; else q.push(action);
  saveQueue(q);
}

/* ---------------- Mapeamento entre o app e as tabelas ---------------- */
const TYPE_CONFIG = {
  abordagens: { table:'abordagens', fields:['rg_cpf','nome','vulgo','nome_mae','data_nascimento','artigos','observacoes','endereco_moradia','endereco_abordagem','lat','lng'] },
  locais:     { table:'locais',     fields:['nome_local','endereco','nivel_ameaca','lat','lng'] },
  procurados: { table:'procurados', fields:['rg_cpf','nome','vulgo','nome_mae','data_nascimento','numero_mandado','mandado_link','artigos','observacoes','endereco','lat','lng'] }
};

function toRow(type, item, fotoUrl){
  const cfg = TYPE_CONFIG[type];
  const row = { id:item.id, user_id: currentUserId, criado_em:item.criadoEm, atualizado_em:item.atualizadoEm };
  cfg.fields.forEach(f=> row[f] = (item[f] !== undefined && item[f] !== '') ? item[f] : null);
  if(fotoUrl !== undefined) row.foto_url = fotoUrl;
  return row;
}
function fromRow(type, row){
  const cfg = TYPE_CONFIG[type];
  const item = { id: row.id, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em, foto: null, _fotoPath: row.foto_url || null };
  cfg.fields.forEach(f=> item[f] = row[f] !== null ? row[f] : '');
  if(item.lat === '') item.lat = null;
  if(item.lng === '') item.lng = null;
  return item;
}

/* ---------------- Fotos: upload pro Storage (não engorda o banco) ---------------- */
function dataUrlToBlob(dataUrl){
  const [meta, base64] = dataUrl.split(',');
  const mime = (meta.match(/data:([^;]+);/)||[])[1] || 'image/jpeg';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function uploadFotoSeNecessario(type, item){
  if(!item.foto || !item.foto.startsWith('data:')) return undefined; // sem foto nova pra subir
  try{
    const blob = dataUrlToBlob(item.foto);
    const path = `${currentUserId}/${type}/${item.id}.jpg`;
    const { error } = await sb.storage.from(FOTOS_BUCKET).upload(path, blob, { upsert:true, contentType: blob.type });
    if(error) throw error;
    return path;
  }catch(e){
    console.error('Falha ao subir foto', e);
    return undefined; // segue sem foto_url; tenta de novo na próxima sincronização
  }
}

async function resolverFotoParaExibir(item){
  if(!item._fotoPath) return item;
  try{
    const { data, error } = await sb.storage.from(FOTOS_BUCKET).createSignedUrl(item._fotoPath, 3600);
    if(!error && data) item.foto = data.signedUrl;
  }catch(e){ /* segue sem foto se falhar */ }
  return item;
}

/* ---------------- Push: enviar 1 registro / exclusão pra nuvem ---------------- */
async function pushOne(type, item){
  if(!currentUserId) return;
  setSyncStatus('syncing');
  try{
    const fotoUrl = await uploadFotoSeNecessario(type, item);
    const row = toRow(type, item, fotoUrl);
    const { error } = await sb.from(TYPE_CONFIG[type].table).upsert(row);
    if(error) throw error;
    setSyncStatus('idle');
  }catch(e){
    console.error('Falha ao sincronizar', type, e);
    enqueue({ kind:'save', type, table:TYPE_CONFIG[type].table, id:item.id, item });
    setSyncStatus(navigator.onLine ? 'error' : 'offline');
  }
}
async function pushDelete(type, id){
  if(!currentUserId) return;
  setSyncStatus('syncing');
  try{
    const { error } = await sb.from(TYPE_CONFIG[type].table).delete().eq('id', id);
    if(error) throw error;
    setSyncStatus('idle');
  }catch(e){
    console.error('Falha ao excluir na nuvem', type, e);
    enqueue({ kind:'delete', type, table:TYPE_CONFIG[type].table, id });
    setSyncStatus(navigator.onLine ? 'error' : 'offline');
  }
}

window.MDT_HOOKS = {
  onSave: (type, item)=> pushOne(type, item),
  onDelete: (type, id)=> pushDelete(type, id)
};

/* ---------------- Esvaziar a fila de pendências quando voltar a conexão ---------------- */
async function flushQueue(){
  if(!currentUserId) return;
  let q = loadQueue();
  if(q.length===0) return;
  setSyncStatus('syncing');
  const restante = [];
  for(const acao of q){
    try{
      if(acao.kind==='save'){
        const fotoUrl = await uploadFotoSeNecessario(acao.type, acao.item);
        const row = toRow(acao.type, acao.item, fotoUrl);
        const { error } = await sb.from(acao.table).upsert(row);
        if(error) throw error;
      } else {
        const { error } = await sb.from(acao.table).delete().eq('id', acao.id);
        if(error) throw error;
      }
    }catch(e){
      restante.push(acao); // continua na fila pra tentar depois
    }
  }
  saveQueue(restante);
  setSyncStatus(restante.length ? 'error' : 'idle');
}

/* ---------------- Pull + merge (mescla nuvem com local, o mais recente vence) ---------------- */
async function pullAndMergeTipo(type){
  const cfg = TYPE_CONFIG[type];
  const { data, error } = await sb.from(cfg.table).select('*');
  if(error){ console.error('Falha ao buscar', type, error); return; }
  const getLocal = type==='abordagens' ? window.MDT.getAbordagens : type==='locais' ? window.MDT.getLocais : window.MDT.getProcurados;
  const localArr = getLocal();
  const porId = new Map(localArr.map(it=>[it.id, it]));

  for(const row of data){
    const remoto = fromRow(type, row);
    const local = porId.get(remoto.id);
    if(!local){
      await resolverFotoParaExibir(remoto);
      porId.set(remoto.id, remoto);
    } else if((remoto.atualizadoEm||'') > (local.atualizadoEm||'')){
      remoto.foto = local.foto; // mantém a foto local (base64) se já tinha; só busca se realmente faltar
      if(!local.foto) await resolverFotoParaExibir(remoto);
      porId.set(remoto.id, remoto);
    }
    // se o local for mais novo, mantém o local como está (vai subir no próximo push)
  }
  const merged = [...porId.values()];
  if(type==='abordagens') window.MDT.replaceAbordagens(merged);
  else if(type==='locais') window.MDT.replaceLocais(merged);
  else window.MDT.replaceProcurados(merged);
}

async function pullAndMergeAll(){
  setSyncStatus('syncing');
  try{
    await pullAndMergeTipo('abordagens');
    await pullAndMergeTipo('locais');
    await pullAndMergeTipo('procurados');
    await flushQueue();
    setSyncStatus('idle');
  }catch(e){
    console.error('Falha na sincronização inicial', e);
    setSyncStatus('error');
  }
}

/* ---------------- Online / offline ---------------- */
window.addEventListener('online', ()=>{ setSyncStatus('syncing'); flushQueue(); });
window.addEventListener('offline', ()=> setSyncStatus('offline'));

/* ============================================================
   LOGIN
   ============================================================ */
const loginScreen = document.getElementById('loginScreen');
const loginErro = document.getElementById('login_erro');
const loginStatus = document.getElementById('login_status');

function entrarNoApp(session){
  currentUserId = session.user.id;
  loginScreen.classList.add('hidden');
  setSyncStatus(navigator.onLine ? 'syncing' : 'offline');
  if(navigator.onLine) pullAndMergeAll();
}

document.getElementById('login_btnEntrar').addEventListener('click', async ()=>{
  loginErro.textContent = '';
  const email = document.getElementById('login_email').value.trim();
  const senha = document.getElementById('login_senha').value;
  if(!email || !senha){ loginErro.textContent = 'Preencha e-mail e senha.'; return; }
  loginStatus.textContent = 'Entrando...';
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  loginStatus.textContent = '';
  if(error){ loginErro.textContent = 'Falha ao entrar: ' + error.message; return; }
  entrarNoApp(data.session);
});

document.getElementById('login_btnCriarConta').addEventListener('click', async ()=>{
  loginErro.textContent = '';
  const email = document.getElementById('login_email').value.trim();
  const senha = document.getElementById('login_senha').value;
  if(!email || !senha){ loginErro.textContent = 'Preencha e-mail e senha pra criar a conta.'; return; }
  if(senha.length < 6){ loginErro.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
  loginStatus.textContent = 'Criando conta...';
  const { data, error } = await sb.auth.signUp({ email, password: senha });
  loginStatus.textContent = '';
  if(error){ loginErro.textContent = 'Falha ao criar conta: ' + error.message; return; }
  if(data.session){ entrarNoApp(data.session); }
  else { loginStatus.textContent = '✅ Conta criada! Verifique seu e-mail para confirmar antes de entrar.'; }
});

/* Sessão já existente (login anterior salvo pelo navegador) */
sb.auth.getSession().then(({ data })=>{
  if(data && data.session){ entrarNoApp(data.session); }
});

})();

(function(){
"use strict";

/* ============================================================
   MDT TÁTICO - POLÍCIA
   Aplicação single-file: mapa + rastreamento GPS + CRUD local
   Armazenamento: localStorage (dados + fotos comprimidas em base64)
   ============================================================ */

const STORAGE_KEYS = { abordagens:'mdt_abordagens_v1', locais:'mdt_locais_v1', procurados:'mdt_procurados_v1' };

/* ---------------- Helpers gerais ---------------- */
function uid(){ return 'id_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8); }
function nowIso(){ return new Date().toISOString(); }
function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDateShort(iso){
  try{ const d=new Date(iso); return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
  catch(e){ return ''; }
}

let toastTimer=null;
function toast(msg, kind){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.borderColor = kind==='err' ? 'rgba(239,68,68,0.6)' : kind==='ok' ? 'rgba(34,197,94,0.6)' : 'var(--border-strong)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'), 2600);
}

/* ---------------- Armazenamento local ---------------- */
function loadData(key){
  try{ const raw=localStorage.getItem(key); return raw? JSON.parse(raw) : []; }
  catch(e){ console.error('Erro ao ler storage', e); return []; }
}
function saveData(key, arr){
  try{
    localStorage.setItem(key, JSON.stringify(arr));
    return true;
  }catch(e){
    console.error('Erro ao salvar storage', e);
    toast('⚠️ Armazenamento local cheio. Apague fotos/registros antigos.', 'err');
    return false;
  }
}

let abordagens = loadData(STORAGE_KEYS.abordagens);
let locais = loadData(STORAGE_KEYS.locais);
let procurados = loadData(STORAGE_KEYS.procurados);

/* ---------------- Compressão de imagem ---------------- */
function compressImage(file, maxWidth=560, quality=0.55){
  return new Promise((resolve, reject)=>{
    if(!file){ resolve(null); return; }
    const reader=new FileReader();
    reader.onerror = ()=>reject(new Error('Falha ao ler arquivo'));
    reader.onload = (e)=>{
      const img=new Image();
      img.onerror = ()=>reject(new Error('Falha ao carregar imagem'));
      img.onload = ()=>{
        let w=img.width, h=img.height;
        if(w>maxWidth){ h = Math.round(h * (maxWidth/w)); w = maxWidth; }
        const canvas=document.createElement('canvas');
        canvas.width=w; canvas.height=h;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(img,0,0,w,h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   MAPA (MapLibre GL JS + tiles vetoriais gratuitas OpenFreeMap)
   ============================================================ */
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [-46.2528, -23.9968], // MapLibre usa [lng, lat]
  zoom: 14,
  attributionControl: { compact:true }
});
map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'bottom-left');

let userMarker = null;
let userLatLng = null;
let hasCenteredOnUser = false;

function makeMarkerEl(type, nivel){
  let cls='abordagem', emoji='🚨';
  if(type==='local'){
    cls = nivel==='alto' ? 'local-alto' : 'local-normal';
    emoji = nivel==='alto' ? '☠️' : '🏚️';
  } else if(type==='procurado'){
    cls = 'procurado'; emoji = '🚓';
  }
  const el = document.createElement('div');
  el.className = 'mdt-marker';
  el.innerHTML = `<div class="bubble ${cls}"><span>${emoji}</span></div>`;
  return el;
}
function makeUserMarkerEl(){
  const el = document.createElement('div');
  el.className = 'mdt-marker';
  el.innerHTML = '<div class="user-marker"></div>';
  return el;
}

/* ---------------- Render de marcadores ---------------- */
function popupAbordagem(item){
  const artigos = item.artigos ? escapeHtml(item.artigos).slice(0,180) : '—';
  const vulgo = item.vulgo ? ` <span style="color:var(--text-dim);font-weight:400;">"${escapeHtml(item.vulgo)}"</span>` : '';
  return `<div class="pop">
    ${item.foto ? `<img src="${item.foto}">` : ''}
    <h3>${escapeHtml(item.nome)||'Não identificado'}${vulgo}</h3>
    <div class="row"><b>Doc:</b> ${escapeHtml(item.rg_cpf)||'Sem documento'}</div>
    <div class="row"><b>Mãe:</b> ${escapeHtml(item.nome_mae)||'—'}</div>
    <div class="row"><b>Nasc:</b> ${item.data_nascimento || '—'}</div>
    <div class="row"><b>Artigos:</b> ${artigos}</div>
    <div class="row"><b>Local:</b> ${escapeHtml(item.endereco_abordagem)||'—'}</div>
    ${item.observacoes ? `<div class="row"><b>Obs:</b> ${escapeHtml(item.observacoes).slice(0,150)}</div>` : ''}
    <div class="pop-actions">
      <button data-edit-ab="${item.id}">✏️ Editar</button>
      <button data-del-ab="${item.id}">🗑️ Excluir</button>
    </div>
  </div>`;
}
function popupLocal(item){
  const alto = item.nivel_ameaca==='alto';
  return `<div class="pop ${alto?'danger-pop':''}">
    ${alto ? `<div class="pop-alert">⚠️ Alto Risco / Confronto Armado</div>` : ''}
    ${item.foto ? `<img src="${item.foto}">` : ''}
    <h3>${escapeHtml(item.nome_local)||'Local sem nome'}</h3>
    <div class="row"><b>Endereço:</b> ${escapeHtml(item.endereco)||'—'}</div>
    <div class="row"><b>Nível:</b> ${alto? '☠️ Alto Risco':'🟡 Normal'}</div>
    <div class="pop-actions">
      <button data-edit-lo="${item.id}">✏️ Editar</button>
      <button data-del-lo="${item.id}">🗑️ Excluir</button>
    </div>
  </div>`;
}

function popupProcurado(item){
  const vulgo = item.vulgo ? ` <span style="color:var(--text-dim);font-weight:400;">"${escapeHtml(item.vulgo)}"</span>` : '';
  const mandadoBtn = item.mandado_link ? `<button type="button" onclick="window.open('${escapeHtml(item.mandado_link)}','_blank')">📄 Mandado</button>` : '';
  return `<div class="pop">
    <div class="pop-alert">🚓 PROCURADO</div>
    ${item.foto ? `<img src="${item.foto}">` : ''}
    <h3>${escapeHtml(item.nome)||'Não identificado'}${vulgo}</h3>
    <div class="row"><b>Doc:</b> ${escapeHtml(item.rg_cpf)||'Sem documento'}</div>
    <div class="row"><b>Mandado:</b> ${escapeHtml(item.numero_mandado)||'—'}</div>
    <div class="row"><b>Endereço:</b> ${escapeHtml(item.endereco)||'—'}</div>
    ${item.artigos ? `<div class="row"><b>Motivo:</b> ${escapeHtml(item.artigos)}</div>` : ''}
    <div class="pop-actions">
      ${mandadoBtn}
      <button data-edit-pr="${item.id}">✏️ Editar</button>
      <button data-del-pr="${item.id}">🗑️ Excluir</button>
    </div>
  </div>`;
}

const markerRefs = { ab:{}, lo:{}, pr:{} };
const allMarkers = { ab:[], lo:[], pr:[] };
let currentOpenPopup = null;
function closeAnyOpenPopup(){
  if(currentOpenPopup){ currentOpenPopup.remove(); currentOpenPopup = null; }
}

function bindPopupButtons(popup){
  popup.on('open', ()=>{
    currentOpenPopup = popup;
    const node = popup.getElement();
    if(!node) return;
    node.querySelectorAll('[data-edit-ab]').forEach(b=>b.onclick=()=>openAbordagemForm(b.dataset.editAb));
    node.querySelectorAll('[data-del-ab]').forEach(b=>b.onclick=()=>deleteAbordagem(b.dataset.delAb));
    node.querySelectorAll('[data-edit-lo]').forEach(b=>b.onclick=()=>openLocalForm(b.dataset.editLo));
    node.querySelectorAll('[data-del-lo]').forEach(b=>b.onclick=()=>deleteLocal(b.dataset.delLo));
    node.querySelectorAll('[data-edit-pr]').forEach(b=>b.onclick=()=>openProcuradoForm(b.dataset.editPr));
    node.querySelectorAll('[data-del-pr]').forEach(b=>b.onclick=()=>deleteProcurado(b.dataset.delPr));
  });
}

function createMapMarker(item, type){
  const el = makeMarkerEl(type, item.nivel_ameaca);
  const html = type==='local' ? popupLocal(item) : (type==='procurado' ? popupProcurado(item) : popupAbordagem(item));
  const popup = new maplibregl.Popup({ offset:26, closeButton:true, maxWidth:'260px' }).setHTML(html);
  bindPopupButtons(popup);
  return new maplibregl.Marker({ element: el })
    .setLngLat([item.lng, item.lat])
    .setPopup(popup)
    .addTo(map);
}

function openMarkerPopup(marker){
  if(!marker) return;
  const popup = marker.getPopup();
  if(popup && !popup.isOpen()) marker.togglePopup();
}

function refreshMarkers(){
  allMarkers.ab.forEach(m=>m.remove());
  allMarkers.lo.forEach(m=>m.remove());
  allMarkers.pr.forEach(m=>m.remove());
  allMarkers.ab = []; allMarkers.lo = []; allMarkers.pr = [];
  markerRefs.ab = {}; markerRefs.lo = {}; markerRefs.pr = {};

  const showAb = document.getElementById('filterAbordagens').checked;
  const showLo = document.getElementById('filterLocais').checked;
  const showPr = document.getElementById('filterProcurados').checked;

  abordagens.forEach(item=>{
    if(item.lat==null || item.lng==null) return;
    const m = createMapMarker(item, 'abordagem');
    m.getElement().style.display = showAb ? '' : 'none';
    markerRefs.ab[item.id] = m;
    allMarkers.ab.push(m);
  });
  locais.forEach(item=>{
    if(item.lat==null || item.lng==null) return;
    const m = createMapMarker(item, 'local');
    m.getElement().style.display = showLo ? '' : 'none';
    markerRefs.lo[item.id] = m;
    allMarkers.lo.push(m);
  });
  procurados.forEach(item=>{
    if(item.lat==null || item.lng==null) return;
    const m = createMapMarker(item, 'procurado');
    m.getElement().style.display = showPr ? '' : 'none';
    markerRefs.pr[item.id] = m;
    allMarkers.pr.push(m);
  });

  document.getElementById('cntAbord').textContent = abordagens.length;
  document.getElementById('cntLocais').textContent = locais.length;
  document.getElementById('cntProcurados').textContent = procurados.length;
}
refreshMarkers();

/* ---------------- Filtros ---------------- */
document.getElementById('filterAbordagens').addEventListener('change', (e)=>{
  allMarkers.ab.forEach(m=> m.getElement().style.display = e.target.checked ? '' : 'none');
});
document.getElementById('filterLocais').addEventListener('change', (e)=>{
  allMarkers.lo.forEach(m=> m.getElement().style.display = e.target.checked ? '' : 'none');
});
document.getElementById('filterProcurados').addEventListener('change', (e)=>{
  allMarkers.pr.forEach(m=> m.getElement().style.display = e.target.checked ? '' : 'none');
});

/* ============================================================
   GEOLOCALIZAÇÃO EM TEMPO REAL
   ============================================================ */
const addrMainEl = document.getElementById('addrMain');
const addrSubEl = document.getElementById('addrSub');
const gpsDotEl = document.getElementById('gpsDot');

let lastReverseGeocodeAt = 0;
let lastReverseGeocodeLatLng = null;

function distMeters(a,b){
  if(!a||!b) return Infinity;
  const R=6371000, toRad=x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

let lastGpsAccuracy = null;

/* ---------------- Leitura local de rua/bairro (tiles vetoriais, sem chamada de rede) ----------------
   As tiles vetoriais do OpenFreeMap já trazem o nome das ruas e bairros como dado, não como
   imagem — a mesma informação usada para DESENHAR o mapa. Por isso dá pra perguntar "qual rua
   está debaixo deste ponto?" lendo o que já foi baixado, sem gerar nenhuma requisição nova. */
function queryNearbyFeatures(lngLat, boxSizePx){
  if(!map.isStyleLoaded()) return [];
  try{
    const pt = map.project(lngLat);
    return map.queryRenderedFeatures([[pt.x-boxSizePx, pt.y-boxSizePx],[pt.x+boxSizePx, pt.y+boxSizePx]]);
  }catch(e){ return []; }
}
const BAIRRO_CLASSES = ['suburb','neighbourhood','quarter','city_district','borough','hamlet'];
const CIDADE_CLASSES = ['city','town','village','municipality'];

function getLocalStreetInfo(lat, lng){
  const lngLat = [lng, lat];
  const nearRoad = queryNearbyFeatures(lngLat, 8);
  const roadFeat = nearRoad.find(f=> f.sourceLayer==='transportation_name' && f.properties && f.properties.name);

  const nearPlace = queryNearbyFeatures(lngLat, 180);
  const placeNamed = nearPlace.filter(f=> f.sourceLayer==='place' && f.properties && f.properties.name);
  const bairroFeat = placeNamed.find(f=> BAIRRO_CLASSES.includes(f.properties.class)) || placeNamed[0];
  const cidadeFeat = placeNamed.find(f=> CIDADE_CLASSES.includes(f.properties.class));

  return {
    rua: roadFeat ? roadFeat.properties.name : null,
    bairro: bairroFeat ? bairroFeat.properties.name : null,
    cidade: cidadeFeat ? cidadeFeat.properties.name : null
  };
}

function updateAddressPanelLocal(lat, lng){
  const local = getLocalStreetInfo(lat, lng);
  if(!local || (!local.rua && !local.bairro)) return false;
  const precisao = lastGpsAccuracy ? ` • GPS ±${Math.round(lastGpsAccuracy)}m` : '';
  addrMainEl.textContent = local.rua || 'Via não identificada';
  addrSubEl.textContent = ([local.bairro, local.cidade].filter(Boolean).join(' • ') || 'Local desconhecido') + precisao;
  return true;
}

async function reverseGeocode(lat,lng){
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
    const data = await res.json();
    const precisao = lastGpsAccuracy ? ` • GPS ±${Math.round(lastGpsAccuracy)}m` : '';
    if(data && data.address){
      const a = data.address;
      const rua = a.road || a.pedestrian || a.footway || a.residential || 'Via não identificada';
      const numero = a.house_number ? `, ${a.house_number}` : '';
      const bairro = a.suburb || a.neighbourhood || a.village || a.town || '';
      const cidade = a.city || a.town || a.municipality || '';
      addrMainEl.textContent = `${rua}${numero}`;
      addrSubEl.textContent = ([bairro, cidade].filter(Boolean).join(' • ') || 'Local desconhecido') + precisao;
    } else {
      addrMainEl.textContent = 'Endereço não encontrado';
      addrSubEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}${precisao}`;
    }
  }catch(e){
    addrMainEl.textContent = 'Falha ao obter endereço';
    addrSubEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

async function forwardGeocode(query){
  if(!query || !query.trim()) return null;
  try{
    let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&countrycodes=br`;
    // Viés de proximidade: prioriza resultados perto de onde o policial está agora,
    // sem excluir o resto do Brasil (bounded=0) — evita confundir ruas de mesmo nome em outra cidade.
    if(userLatLng){
      const d = 0.35; // ~35km de raio de viés
      url += `&viewbox=${userLatLng.lng-d},${userLatLng.lat+d},${userLatLng.lng+d},${userLatLng.lat-d}&bounded=0`;
    }
    const res = await fetch(url);
    const data = await res.json();
    if(data && data.length>0){
      let best = data[0];
      if(userLatLng){
        best = data.reduce((closest, item)=>{
          const dNew = distMeters(userLatLng, {lat:parseFloat(item.lat), lng:parseFloat(item.lon)});
          const dCur = distMeters(userLatLng, {lat:parseFloat(closest.lat), lng:parseFloat(closest.lon)});
          return dNew < dCur ? item : closest;
        }, data[0]);
      }
      return { lat:parseFloat(best.lat), lng:parseFloat(best.lon), label:best.display_name };
    }
    return null;
  }catch(e){ return null; }
}

/* ---------------- Alerta de proximidade de Procurados ---------------- */
const PROCURADO_ALERT_RADIUS_M = 200;   // distância pra disparar o alerta
const PROCURADO_ALERT_CLEAR_RADIUS_M = 300; // histerese: só "rearma" depois de se afastar bem
let nearbyProcuradosAlerted = new Set();
let procuradoAlertQueue = [];
let procuradoAlertShowing = false;
let procuradoAlertAutoHideTimer = null;

function checkProcuradoProximity(userPos){
  if(!userPos) return;
  procurados.forEach(p=>{
    if(p.lat==null || p.lng==null) return;
    const d = distMeters(userPos, { lat:p.lat, lng:p.lng });
    if(d <= PROCURADO_ALERT_RADIUS_M){
      if(!nearbyProcuradosAlerted.has(p.id)){
        nearbyProcuradosAlerted.add(p.id);
        queueProcuradoAlert(p);
      }
    } else if(d > PROCURADO_ALERT_CLEAR_RADIUS_M){
      nearbyProcuradosAlerted.delete(p.id);
    }
  });
}

function queueProcuradoAlert(p){
  procuradoAlertQueue.push(p);
  if(!procuradoAlertShowing) showNextProcuradoAlert();
}

function showNextProcuradoAlert(){
  if(procuradoAlertQueue.length===0){ procuradoAlertShowing=false; return; }
  procuradoAlertShowing = true;
  const p = procuradoAlertQueue.shift();
  document.getElementById('pa_nome').textContent = (p.nome||'Não identificado') + (p.vulgo? ` "${p.vulgo}"`:'');
  document.getElementById('pa_endereco').textContent = p.endereco || 'Endereço não informado';
  const img = document.getElementById('pa_foto');
  if(p.foto){ img.src = p.foto; img.style.display='block'; } else { img.style.display='none'; }
  const btnMandado = document.getElementById('pa_btnMandado');
  if(p.mandado_link){
    btnMandado.style.display = '';
    btnMandado.onclick = ()=>{ window.open(p.mandado_link, '_blank'); };
  } else {
    btnMandado.style.display = 'none';
  }
  document.getElementById('procuradoAlertCard').classList.add('show');
  if('vibrate' in navigator){ try{ navigator.vibrate([250,120,250,120,250]); }catch(e){} }
  toast(`🚓 Procurado próximo: ${p.nome||'não identificado'}`, 'err');
  clearTimeout(procuradoAlertAutoHideTimer);
  procuradoAlertAutoHideTimer = setTimeout(dismissProcuradoAlert, 12000);
}

function dismissProcuradoAlert(){
  document.getElementById('procuradoAlertCard').classList.remove('show');
  clearTimeout(procuradoAlertAutoHideTimer);
  setTimeout(showNextProcuradoAlert, 400);
}
document.getElementById('pa_btnFechar').addEventListener('click', dismissProcuradoAlert);

function onGpsSuccess(pos){
  const lat=pos.coords.latitude, lng=pos.coords.longitude;
  lastGpsAccuracy = pos.coords.accuracy;
  userLatLng = { lat, lng };
  gpsDotEl.classList.remove('searching');
  gpsDotEl.classList.toggle('imprecise', lastGpsAccuracy > 50);

  if(!userMarker){
    userMarker = new maplibregl.Marker({ element: makeUserMarkerEl() }).setLngLat([lng, lat]).addTo(map);
  } else {
    userMarker.setLngLat([lng, lat]);
  }

  if(!hasCenteredOnUser){
    map.flyTo({ center:[lng,lat], zoom:16 });
    hasCenteredOnUser = true;
  }

  checkProcuradoProximity(userLatLng);

  // 1ª tentativa: leitura local nas tiles vetoriais já carregadas — instantânea e sem custo.
  const foundLocally = updateAddressPanelLocal(lat, lng);
  if(!foundLocally){
    // Reserva: só usa o Nominatim (rede) se a leitura local não achou nada nas tiles,
    // e mesmo assim com o mesmo limitador de antes para não gerar volume.
    const movedEnough = distMeters(lastReverseGeocodeLatLng, userLatLng) > 35;
    const timeElapsed = Date.now() - lastReverseGeocodeAt > 18000;
    if(movedEnough || timeElapsed){
      lastReverseGeocodeAt = Date.now();
      lastReverseGeocodeLatLng = { lat, lng };
      reverseGeocode(lat,lng);
    }
  }
}
function onGpsError(err){
  gpsDotEl.classList.add('searching');
  addrMainEl.textContent = 'GPS indisponível';
  addrSubEl.textContent = err && err.message ? err.message : 'Verifique a permissão de localização';
}

if('geolocation' in navigator){
  navigator.geolocation.watchPosition(onGpsSuccess, onGpsError, { enableHighAccuracy:true, maximumAge:4000, timeout:15000 });
} else {
  addrMainEl.textContent = 'Geolocalização não suportada neste navegador';
}

document.getElementById('recenterBtn').addEventListener('click', ()=>{
  if(userLatLng) map.flyTo({ center:[userLatLng.lng, userLatLng.lat], zoom:17 });
  else toast('Aguardando sinal de GPS...');
});

/* ============================================================
   TOGGLE INTERFACE (ocultar/mostrar)
   ============================================================ */
document.getElementById('toggleUiBtn').addEventListener('click', ()=>{
  document.body.classList.toggle('ui-hidden');
  const btn = document.getElementById('toggleUiBtn');
  btn.textContent = document.body.classList.contains('ui-hidden') ? '🗺️' : '👁️';
  document.getElementById('filtersPanel').classList.remove('open');
  document.getElementById('fabContainer').classList.remove('open');
});

/* ============================================================
   FILTROS: ícone recolhido -> abre painel
   ============================================================ */
const filtersPanelEl = document.getElementById('filtersPanel');
document.getElementById('filtersToggleBtn').addEventListener('click', (e)=>{
  e.stopPropagation();
  filtersPanelEl.classList.toggle('open');
});
document.addEventListener('click', (e)=>{
  if(filtersPanelEl.classList.contains('open') && !filtersPanelEl.contains(e.target) && e.target.id!=='filtersToggleBtn'){
    filtersPanelEl.classList.remove('open');
  }
});

/* ============================================================
   FAB: menu de ações (Nova Abordagem / Novo Local)
   ============================================================ */
const fabContainerEl = document.getElementById('fabContainer');
document.getElementById('fabMain').addEventListener('click', (e)=>{
  e.stopPropagation();
  fabContainerEl.classList.toggle('open');
});
document.addEventListener('click', (e)=>{
  if(fabContainerEl.classList.contains('open') && !fabContainerEl.contains(e.target)){
    fabContainerEl.classList.remove('open');
  }
});

/* ============================================================
   SELECIONAR LOCAL EXATO NO MAPA (pin-drop)
   ============================================================ */
let locPickerTarget = null;      // 'ab' | 'lo'
let locPickerFromOverlay = null; // overlay a reabrir ao confirmar/cancelar
const locPickerEl = document.getElementById('locPicker');

function startLocationPicker(target, fromOverlayId){
  locPickerTarget = target;
  locPickerFromOverlay = fromOverlayId;
  closeOverlay(fromOverlayId);
  const current = target==='ab' ? ab_selectedLoc : lo_selectedLoc;
  const center = current || userLatLng;
  if(center) map.jumpTo({ center:[center.lng, center.lat], zoom:Math.max(map.getZoom(), 17) });
  locPickerEl.classList.add('open');
  setTimeout(()=>map.resize(), 50);
}

document.getElementById('locPickerCancel').addEventListener('click', ()=>{
  locPickerEl.classList.remove('open');
  if(locPickerFromOverlay) openOverlay(locPickerFromOverlay);
});

function formatEnderecoFromNominatim(data){
  if(!data || !data.address) return (data && data.display_name) || null;
  const a = data.address;
  const rua = a.road || a.pedestrian || a.footway || a.residential || null;
  const numero = a.house_number ? `, ${a.house_number}` : '';
  const bairro = a.suburb || a.neighbourhood || a.village || a.town || '';
  const cidade = a.city || a.town || a.municipality || '';
  const partes = [ rua ? `${rua}${numero}` : null, bairro, cidade ].filter(Boolean);
  return partes.length ? partes.join(', ') : (data.display_name || null);
}

function showAddrSuggestion(prefix, text){
  const box = document.getElementById(`${prefix}_addrSuggestion`);
  if(!box) return;
  if(!text){ box.style.display='none'; return; }
  box.querySelector('.ast').textContent = text;
  box.style.display='flex';
  box.querySelector('.addr-suggestion-use').onclick = ()=>{
    document.getElementById(`${prefix}_endereco`).value = text;
    box.style.display='none';
  };
}

document.getElementById('locPickerConfirm').addEventListener('click', async ()=>{
  const c = map.getCenter();
  const picked = { lat:c.lat, lng:c.lng };
  locPickerEl.classList.remove('open');
  if(locPickerFromOverlay) openOverlay(locPickerFromOverlay);

  const targetPrefix = locPickerTarget; // 'ab' | 'lo'
  if(targetPrefix==='ab'){ ab_selectedLoc = picked; setAbLocHint(true, 'Localização marcada manualmente no mapa'); }
  else { lo_selectedLoc = picked; setLoLocHint(true, 'Localização marcada manualmente no mapa'); }

  toast('📍 Local marcado. Digite o endereço que você está vendo — o mapa só sugere, não preenche sozinho.', 'ok');
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${picked.lat}&lon=${picked.lng}&zoom=18&addressdetails=1`);
    const data = await res.json();
    showAddrSuggestion(targetPrefix, formatEnderecoFromNominatim(data));
  }catch(e){ showAddrSuggestion(targetPrefix, null); }
});

/* ============================================================
   MODAIS: abrir / fechar
   ============================================================ */
function openOverlay(id){ document.getElementById(id).classList.add('open'); }
function closeOverlay(id){ document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('[data-close]').forEach(el=>{
  el.addEventListener('click', ()=>closeOverlay(el.dataset.close));
});
document.querySelectorAll('.overlay').forEach(ov=>{
  ov.addEventListener('click', (e)=>{ if(e.target===ov) ov.classList.remove('open'); });
});

/* ============================================================
   FORMULÁRIO: ABORDAGEM
   ============================================================ */
let ab_selectedLoc = null; // {lat,lng}
let ab_photoData = null;

/* ---------------- Chips de artigos (reutilizável) ---------------- */
function syncChipValue(rowId, hiddenId){
  const row = document.getElementById(rowId);
  const active = [...row.querySelectorAll('.chip.active')].map(c=>c.dataset.artigo);
  document.getElementById(hiddenId).value = active.join(', ');
}
function bindChip(chip, rowId, hiddenId){
  chip.addEventListener('click', ()=>{
    chip.classList.toggle('active');
    syncChipValue(rowId, hiddenId);
  });
}
function setupChipRow(rowId, hiddenId){
  document.querySelectorAll(`#${rowId} .chip`).forEach(chip=>bindChip(chip, rowId, hiddenId));
}
function addChipFromSelect(rowId, hiddenId, value){
  if(!value) return;
  const row = document.getElementById(rowId);
  let chip = [...row.querySelectorAll('.chip')].find(c=>c.dataset.artigo===value);
  if(!chip){
    chip = document.createElement('div');
    chip.className='chip extra active';
    chip.dataset.artigo=value;
    chip.textContent=value;
    bindChip(chip, rowId, hiddenId);
    row.appendChild(chip);
  } else {
    chip.classList.add('active');
  }
  syncChipValue(rowId, hiddenId);
}
function setChipsFromValue(rowId, hiddenId, rawValue){
  const row = document.getElementById(rowId);
  row.querySelectorAll('.chip.extra').forEach(c=>c.remove());
  row.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  const parts = (rawValue||'').split(',').map(s=>s.trim()).filter(Boolean);
  parts.forEach(p=>{
    let chip = [...row.querySelectorAll('.chip')].find(c=>c.dataset.artigo===p);
    if(!chip){
      chip = document.createElement('div');
      chip.className='chip extra active';
      chip.dataset.artigo=p;
      chip.textContent=p;
      bindChip(chip, rowId, hiddenId);
      row.appendChild(chip);
    } else {
      chip.classList.add('active');
    }
  });
  syncChipValue(rowId, hiddenId);
}
/* ---------------- Lista de artigos para busca ---------------- */
setupChipRow('ab_chipRow','ab_artigos');
const ARTIGOS_LISTA = [
  {codigo:'Art. 121', desc:'Homicídio'},
  {codigo:'Art. 121 §2º', desc:'Homicídio Qualificado'},
  {codigo:'Art. 129', desc:'Lesão Corporal'},
  {codigo:'Art. 129 §9º', desc:'Violência Doméstica'},
  {codigo:'Art. 130', desc:'Perigo de Contágio Venéreo'},
  {codigo:'Art. 133', desc:'Abandono de Incapaz'},
  {codigo:'Art. 135', desc:'Omissão de Socorro'},
  {codigo:'Art. 136', desc:'Maus-Tratos'},
  {codigo:'Art. 138', desc:'Calúnia'},
  {codigo:'Art. 139', desc:'Difamação'},
  {codigo:'Art. 140', desc:'Injúria'},
  {codigo:'Art. 147', desc:'Ameaça'},
  {codigo:'Art. 148', desc:'Sequestro e Cárcere Privado'},
  {codigo:'Art. 155', desc:'Furto'},
  {codigo:'Art. 155 §4º', desc:'Furto Qualificado'},
  {codigo:'Art. 157', desc:'Roubo'},
  {codigo:'Art. 157 §2º', desc:'Roubo Qualificado'},
  {codigo:'Art. 158', desc:'Extorsão'},
  {codigo:'Art. 159', desc:'Extorsão Mediante Sequestro'},
  {codigo:'Art. 163', desc:'Dano'},
  {codigo:'Art. 171', desc:'Estelionato'},
  {codigo:'Art. 180', desc:'Receptação'},
  {codigo:'Art. 213', desc:'Estupro'},
  {codigo:'Art. 217-A', desc:'Estupro de Vulnerável'},
  {codigo:'Art. 244-B ECA', desc:'Corrupção de Menores'},
  {codigo:'Art. 288', desc:'Associação Criminosa'},
  {codigo:'Art. 297', desc:'Falsificação de Documento Público'},
  {codigo:'Art. 298', desc:'Falsificação de Documento Particular'},
  {codigo:'Art. 299', desc:'Falsidade Ideológica'},
  {codigo:'Art. 306 CTB', desc:'Embriaguez ao Volante'},
  {codigo:'Art. 309 CTB', desc:'Dirigir sem Habilitação'},
  {codigo:'Art. 330', desc:'Desobediência'},
  {codigo:'Art. 331', desc:'Desacato'},
  {codigo:'Art. 333', desc:'Corrupção Ativa'},
  {codigo:'Art. 334', desc:'Contrabando/Descaminho'},
  {codigo:'Art. 28 Lei 11.343', desc:'Posse de Drogas p/ Consumo'},
  {codigo:'Art. 33 Lei 11.343', desc:'Tráfico de Drogas'},
  {codigo:'Art. 35 Lei 11.343', desc:'Associação para o Tráfico'},
  {codigo:'Art. 12 Lei 10.826', desc:'Posse de Arma de Fogo'},
  {codigo:'Art. 14 Lei 10.826', desc:'Porte Ilegal de Arma de Fogo'},
  {codigo:'Art. 16 Lei 10.826', desc:'Posse/Porte de Arma Restrita'},
  {codigo:'Art. 21 LCP', desc:'Vias de Fato'},
  {codigo:'Art. 65 LCP', desc:'Perturbação da Tranquilidade'}
];
const artigoSearchInput = document.getElementById('ab_artigoSearch');
const artigoResultsEl = document.getElementById('ab_artigoResults');
function renderArtigoResults(query){
  const q = query.trim().toLowerCase();
  if(!q){ artigoResultsEl.innerHTML=''; artigoResultsEl.classList.remove('open'); return; }
  const matches = ARTIGOS_LISTA.filter(a=> a.codigo.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)).slice(0,8);
  artigoResultsEl.innerHTML = matches.length
    ? matches.map(a=>`<div class="artigo-result-item" data-code="${escapeHtml(a.codigo)}"><b>${escapeHtml(a.codigo)}</b> — ${escapeHtml(a.desc)}</div>`).join('')
    : `<div class="artigo-result-empty">Nenhum artigo encontrado</div>`;
  artigoResultsEl.classList.add('open');
}
artigoSearchInput.addEventListener('input', ()=>renderArtigoResults(artigoSearchInput.value));
artigoSearchInput.addEventListener('focus', ()=>{ if(artigoSearchInput.value.trim()) renderArtigoResults(artigoSearchInput.value); });
artigoResultsEl.addEventListener('click', (e)=>{
  const item = e.target.closest('.artigo-result-item');
  if(!item || !item.dataset.code) return;
  addChipFromSelect('ab_chipRow','ab_artigos', item.dataset.code);
  artigoSearchInput.value='';
  artigoResultsEl.innerHTML=''; artigoResultsEl.classList.remove('open');
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.artigo-search-wrap')) artigoResultsEl.classList.remove('open');
});

function resetAbordagemForm(){
  document.getElementById('formAbordagem').reset();
  document.getElementById('ab_id').value = '';
  document.getElementById('tituloAbordagem').textContent = 'Nova Abordagem';
  showAddrSuggestion('ab', null);
  ab_selectedLoc = null;
  ab_photoData = null;
  document.getElementById('ab_photoPreview').style.display='none';
  document.getElementById('ab_photoEmpty').style.display='block';
  document.getElementById('ab_removePhoto').style.display='none';
  document.getElementById('ab_locHint').textContent = 'Nenhuma localização definida ainda.';
  document.getElementById('ab_locHint').className='field-hint';
  document.getElementById('ab_autofill_flag').classList.remove('show');
  document.getElementById('ab_semDoc').checked = false;
  document.getElementById('ab_doc').disabled = false;
  document.getElementById('ab_btnVerificar').disabled = false;
  setChipsFromValue('ab_chipRow','ab_artigos','');
}

function openAbordagemForm(editId){
  resetAbordagemForm();
  if(editId){
    const item = abordagens.find(x=>x.id===editId);
    if(!item) return;
    document.getElementById('tituloAbordagem').textContent = 'Editar Abordagem';
    document.getElementById('ab_id').value = item.id;
    document.getElementById('ab_doc').value = item.rg_cpf||'';
    document.getElementById('ab_nome').value = item.nome||'';
    document.getElementById('ab_vulgo').value = item.vulgo||'';
    document.getElementById('ab_mae').value = item.nome_mae||'';
    document.getElementById('ab_nasc').value = item.data_nascimento||'';
    document.getElementById('ab_moradia').value = item.endereco_moradia||'';
    document.getElementById('ab_endereco').value = item.endereco_abordagem||'';
    document.getElementById('ab_obs').value = item.observacoes||'';
    setChipsFromValue('ab_chipRow','ab_artigos', item.artigos||'');
    if(!item.rg_cpf){
      document.getElementById('ab_semDoc').checked = true;
      document.getElementById('ab_doc').disabled = true;
      document.getElementById('ab_btnVerificar').disabled = true;
    }
    if(item.lat!=null && item.lng!=null){
      ab_selectedLoc = { lat:item.lat, lng:item.lng };
      setAbLocHint(true, item.endereco_abordagem || 'Localização definida');
    }
    if(item.foto){
      ab_photoData = item.foto;
      document.getElementById('ab_photoPreview').src = item.foto;
      document.getElementById('ab_photoPreview').style.display='block';
      document.getElementById('ab_photoEmpty').style.display='none';
      document.getElementById('ab_removePhoto').style.display='inline';
    }
  }
  closeOverlay('archiveSheet');
  closeOverlay('personSheet');
  openOverlay('overlayAbordagem');
}
document.getElementById('btnNovaAbordagem').addEventListener('click', ()=>{ fabContainerEl.classList.remove('open'); openAbordagemForm(null); });

document.getElementById('ab_semDoc').addEventListener('change', (e)=>{
  const docInput = document.getElementById('ab_doc');
  const btnV = document.getElementById('ab_btnVerificar');
  docInput.disabled = e.target.checked;
  btnV.disabled = e.target.checked;
  if(e.target.checked){
    docInput.value='';
    document.getElementById('ab_autofill_flag').classList.remove('show');
  }
});

function setAbLocHint(ok, text){
  const el = document.getElementById('ab_locHint');
  el.textContent = ok ? `✅ ${text}` : `❌ ${text}`;
  el.className = 'field-hint ' + (ok?'ok':'err');
}

function gpsAccuracySuffix(){
  return (lastGpsAccuracy && lastGpsAccuracy > 50) ? ` (⚠️ GPS impreciso, ±${Math.round(lastGpsAccuracy)}m — confira/ajuste com 🗺️)` : '';
}

document.getElementById('ab_btnGps').addEventListener('click', async ()=>{
  if(!userLatLng){ toast('GPS ainda não disponível, aguarde o sinal.', 'err'); return; }
  ab_selectedLoc = { lat:userLatLng.lat, lng:userLatLng.lng };
  setAbLocHint(true, 'Coordenadas GPS atuais capturadas' + gpsAccuracySuffix());
  if(lastGpsAccuracy && lastGpsAccuracy > 50){
    toast(`⚠️ Sinal de GPS impreciso (±${Math.round(lastGpsAccuracy)}m). Confira o endereço ou ajuste com 🗺️ Selecionar no Mapa.`, 'err');
  }
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${userLatLng.lat}&lon=${userLatLng.lng}&zoom=18&addressdetails=1`);
    const data = await res.json();
    showAddrSuggestion('ab', formatEnderecoFromNominatim(data));
  }catch(e){ showAddrSuggestion('ab', null); }
});

document.getElementById('ab_btnBuscarEndereco').addEventListener('click', async ()=>{
  const val = document.getElementById('ab_endereco').value;
  if(!val.trim()){ toast('Digite um endereço para buscar.', 'err'); return; }
  setAbLocHint(true, 'Buscando no mapa...');
  const result = await forwardGeocode(val);
  if(result){
    ab_selectedLoc = { lat:result.lat, lng:result.lng };
    setAbLocHint(true, 'Endereço localizado no mapa');
  } else {
    setAbLocHint(false, 'Endereço não encontrado, tente ser mais específico');
  }
});

document.getElementById('ab_btnMapPick').addEventListener('click', ()=>{
  startLocationPicker('ab', 'overlayAbordagem');
});

document.getElementById('ab_photoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  toast('Processando foto...');
  const compressed = await compressImage(file);
  ab_photoData = compressed;
  document.getElementById('ab_photoPreview').src = compressed;
  document.getElementById('ab_photoPreview').style.display='block';
  document.getElementById('ab_photoEmpty').style.display='none';
  document.getElementById('ab_removePhoto').style.display='inline';
});
document.getElementById('ab_removePhoto').addEventListener('click', ()=>{
  ab_photoData = null;
  document.getElementById('ab_photoInput').value='';
  document.getElementById('ab_photoPreview').style.display='none';
  document.getElementById('ab_photoEmpty').style.display='block';
  document.getElementById('ab_removePhoto').style.display='none';
});

/* Auto-preenchimento por RG/CPF */
function checkAbAutoFill(silent){
  const doc = document.getElementById('ab_doc').value.trim();
  const currentId = document.getElementById('ab_id').value;
  if(!doc){ if(!silent) toast('Digite um documento para verificar.', 'err'); return; }
  const match = abordagens.find(x=> x.rg_cpf && x.rg_cpf.trim()===doc && x.id!==currentId);
  if(match){
    if(!document.getElementById('ab_nome').value) document.getElementById('ab_nome').value = match.nome||'';
    if(!document.getElementById('ab_vulgo').value) document.getElementById('ab_vulgo').value = match.vulgo||'';
    if(!document.getElementById('ab_mae').value) document.getElementById('ab_mae').value = match.nome_mae||'';
    if(!document.getElementById('ab_nasc').value) document.getElementById('ab_nasc').value = match.data_nascimento||'';
    if(!document.getElementById('ab_moradia').value) document.getElementById('ab_moradia').value = match.endereco_moradia||'';
    document.getElementById('ab_autofill_flag').classList.add('show');
    toast('Indivíduo já registrado — dados preenchidos automaticamente', 'ok');
  } else if(!silent){
    toast('Nenhum registro anterior encontrado para este documento.');
  }

  const wantedMatch = procurados.find(p=> p.rg_cpf && p.rg_cpf.trim()===doc);
  if(wantedMatch){
    toast(`🚓⚠️ ATENÇÃO: este documento consta como PROCURADO — ${wantedMatch.nome||'nome não informado'}`, 'err');
    if('vibrate' in navigator){ try{ navigator.vibrate([300,100,300,100,300]); }catch(e){} }
  }
}
document.getElementById('ab_doc').addEventListener('blur', ()=>checkAbAutoFill(true));
document.getElementById('ab_btnVerificar').addEventListener('click', ()=>checkAbAutoFill(false));

document.getElementById('formAbordagem').addEventListener('submit', (e)=>{
  e.preventDefault();
  if(!ab_selectedLoc){
    toast('Defina a localização da abordagem (GPS ou busca por endereço).', 'err');
    return;
  }
  const id = document.getElementById('ab_id').value || uid();
  const isEdit = !!document.getElementById('ab_id').value;
  const semDoc = document.getElementById('ab_semDoc').checked;
  const item = {
    id,
    rg_cpf: semDoc ? '' : document.getElementById('ab_doc').value.trim(),
    nome: document.getElementById('ab_nome').value.trim(),
    vulgo: document.getElementById('ab_vulgo').value.trim(),
    nome_mae: document.getElementById('ab_mae').value.trim(),
    data_nascimento: document.getElementById('ab_nasc').value,
    artigos: document.getElementById('ab_artigos').value.trim(),
    observacoes: document.getElementById('ab_obs').value.trim(),
    endereco_moradia: document.getElementById('ab_moradia').value.trim(),
    endereco_abordagem: document.getElementById('ab_endereco').value.trim(),
    lat: ab_selectedLoc.lat,
    lng: ab_selectedLoc.lng,
    foto: ab_photoData,
    criadoEm: isEdit ? (abordagens.find(x=>x.id===id)||{}).criadoEm || nowIso() : nowIso(),
    atualizadoEm: nowIso()
  };
  if(isEdit){
    const idx = abordagens.findIndex(x=>x.id===id);
    if(idx>-1) abordagens[idx]=item;
  } else {
    abordagens.push(item);
  }
  if(saveData(STORAGE_KEYS.abordagens, abordagens)){
    refreshMarkers();
    closeOverlay('overlayAbordagem');
    toast(isEdit? '✅ Abordagem atualizada' : '✅ Abordagem registrada', 'ok');
    if(window.MDT_HOOKS && window.MDT_HOOKS.onSave) window.MDT_HOOKS.onSave('abordagens', item);
  }
});

/* ============================================================
   FORMULÁRIO: PROCURADO
   ============================================================ */
let pr_selectedLoc = null;
let pr_photoData = null;

setupChipRow('pr_chipRow','pr_artigos');
const prArtigoSearchInput = document.getElementById('pr_artigoSearch');
const prArtigoResultsEl = document.getElementById('pr_artigoResults');
function renderPrArtigoResults(query){
  const q = query.trim().toLowerCase();
  if(!q){ prArtigoResultsEl.innerHTML=''; prArtigoResultsEl.classList.remove('open'); return; }
  const matches = ARTIGOS_LISTA.filter(a=> a.codigo.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)).slice(0,8);
  prArtigoResultsEl.innerHTML = matches.length
    ? matches.map(a=>`<div class="artigo-result-item" data-code="${escapeHtml(a.codigo)}"><b>${escapeHtml(a.codigo)}</b> — ${escapeHtml(a.desc)}</div>`).join('')
    : `<div class="artigo-result-empty">Nenhum artigo encontrado</div>`;
  prArtigoResultsEl.classList.add('open');
}
prArtigoSearchInput.addEventListener('input', ()=>renderPrArtigoResults(prArtigoSearchInput.value));
prArtigoSearchInput.addEventListener('focus', ()=>{ if(prArtigoSearchInput.value.trim()) renderPrArtigoResults(prArtigoSearchInput.value); });
prArtigoResultsEl.addEventListener('click', (e)=>{
  const item = e.target.closest('.artigo-result-item');
  if(!item || !item.dataset.code) return;
  addChipFromSelect('pr_chipRow','pr_artigos', item.dataset.code);
  prArtigoSearchInput.value='';
  prArtigoResultsEl.innerHTML=''; prArtigoResultsEl.classList.remove('open');
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.artigo-search-wrap')) prArtigoResultsEl.classList.remove('open');
});

function resetProcuradoForm(){
  document.getElementById('formProcurado').reset();
  document.getElementById('pr_id').value = '';
  document.getElementById('tituloProcurado').textContent = 'Novo Procurado';
  showAddrSuggestion('pr', null);
  pr_selectedLoc = null;
  pr_photoData = null;
  document.getElementById('pr_photoPreview').style.display='none';
  document.getElementById('pr_photoEmpty').style.display='block';
  document.getElementById('pr_removePhoto').style.display='none';
  document.getElementById('pr_locHint').textContent = 'Nenhuma localização definida ainda.';
  document.getElementById('pr_locHint').className='field-hint';
  document.getElementById('pr_autofill_flag').classList.remove('show');
  document.getElementById('pr_semDoc').checked = false;
  document.getElementById('pr_doc').disabled = false;
  document.getElementById('pr_btnVerificar').disabled = false;
  setChipsFromValue('pr_chipRow','pr_artigos','');
}

function openProcuradoForm(editId){
  resetProcuradoForm();
  if(editId){
    const item = procurados.find(x=>x.id===editId);
    if(!item) return;
    document.getElementById('tituloProcurado').textContent = 'Editar Procurado';
    document.getElementById('pr_id').value = item.id;
    document.getElementById('pr_doc').value = item.rg_cpf||'';
    document.getElementById('pr_nome').value = item.nome||'';
    document.getElementById('pr_vulgo').value = item.vulgo||'';
    document.getElementById('pr_mae').value = item.nome_mae||'';
    document.getElementById('pr_nasc').value = item.data_nascimento||'';
    document.getElementById('pr_numero_mandado').value = item.numero_mandado||'';
    document.getElementById('pr_mandado_link').value = item.mandado_link||'';
    document.getElementById('pr_endereco').value = item.endereco||'';
    document.getElementById('pr_obs').value = item.observacoes||'';
    setChipsFromValue('pr_chipRow','pr_artigos', item.artigos||'');
    if(!item.rg_cpf){
      document.getElementById('pr_semDoc').checked = true;
      document.getElementById('pr_doc').disabled = true;
      document.getElementById('pr_btnVerificar').disabled = true;
    }
    if(item.lat!=null && item.lng!=null){
      pr_selectedLoc = { lat:item.lat, lng:item.lng };
      setPrLocHint(true, item.endereco || 'Localização definida');
    }
    if(item.foto){
      pr_photoData = item.foto;
      document.getElementById('pr_photoPreview').src = item.foto;
      document.getElementById('pr_photoPreview').style.display='block';
      document.getElementById('pr_photoEmpty').style.display='none';
      document.getElementById('pr_removePhoto').style.display='inline';
    }
  }
  closeOverlay('archiveSheet');
  closeOverlay('personSheet');
  openOverlay('overlayProcurado');
}
document.getElementById('btnNovoProcurado').addEventListener('click', ()=>{ fabContainerEl.classList.remove('open'); openProcuradoForm(null); });

document.getElementById('pr_semDoc').addEventListener('change', (e)=>{
  const docInput = document.getElementById('pr_doc');
  const btnV = document.getElementById('pr_btnVerificar');
  docInput.disabled = e.target.checked;
  btnV.disabled = e.target.checked;
  if(e.target.checked){
    docInput.value='';
    document.getElementById('pr_autofill_flag').classList.remove('show');
  }
});

function setPrLocHint(ok, text){
  const el = document.getElementById('pr_locHint');
  el.textContent = ok ? `✅ ${text}` : `❌ ${text}`;
  el.className = 'field-hint ' + (ok?'ok':'err');
}

document.getElementById('pr_btnGps').addEventListener('click', async ()=>{
  if(!userLatLng){ toast('GPS ainda não disponível, aguarde o sinal.', 'err'); return; }
  pr_selectedLoc = { lat:userLatLng.lat, lng:userLatLng.lng };
  setPrLocHint(true, 'Coordenadas GPS atuais capturadas' + gpsAccuracySuffix());
  if(lastGpsAccuracy && lastGpsAccuracy > 50){
    toast(`⚠️ Sinal de GPS impreciso (±${Math.round(lastGpsAccuracy)}m). Confira o endereço ou ajuste com 🗺️ Selecionar no Mapa.`, 'err');
  }
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${userLatLng.lat}&lon=${userLatLng.lng}&zoom=18&addressdetails=1`);
    const data = await res.json();
    showAddrSuggestion('pr', formatEnderecoFromNominatim(data));
  }catch(e){ showAddrSuggestion('pr', null); }
});

document.getElementById('pr_btnBuscarEndereco').addEventListener('click', async ()=>{
  const val = document.getElementById('pr_endereco').value;
  if(!val.trim()){ toast('Digite um endereço para buscar.', 'err'); return; }
  setPrLocHint(true, 'Buscando no mapa...');
  const result = await forwardGeocode(val);
  if(result){
    pr_selectedLoc = { lat:result.lat, lng:result.lng };
    setPrLocHint(true, 'Endereço localizado no mapa');
  } else {
    setPrLocHint(false, 'Endereço não encontrado, tente ser mais específico');
  }
});

document.getElementById('pr_btnMapPick').addEventListener('click', ()=>{
  startLocationPicker('pr', 'overlayProcurado');
});

document.getElementById('pr_photoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  toast('Processando foto...');
  const compressed = await compressImage(file);
  pr_photoData = compressed;
  document.getElementById('pr_photoPreview').src = compressed;
  document.getElementById('pr_photoPreview').style.display='block';
  document.getElementById('pr_photoEmpty').style.display='none';
  document.getElementById('pr_removePhoto').style.display='inline';
});
document.getElementById('pr_removePhoto').addEventListener('click', ()=>{
  pr_photoData = null;
  document.getElementById('pr_photoInput').value='';
  document.getElementById('pr_photoPreview').style.display='none';
  document.getElementById('pr_photoEmpty').style.display='block';
  document.getElementById('pr_removePhoto').style.display='none';
});

/* Verificação por RG/CPF: procura em Procurados (dedupe) e também em Abordagens (prefill por histórico) */
function checkPrAutoFill(silent){
  const doc = document.getElementById('pr_doc').value.trim();
  const currentId = document.getElementById('pr_id').value;
  if(!doc){ if(!silent) toast('Digite um documento para verificar.', 'err'); return; }
  const matchPr = procurados.find(x=> x.rg_cpf && x.rg_cpf.trim()===doc && x.id!==currentId);
  const matchAb = abordagens.find(x=> x.rg_cpf && x.rg_cpf.trim()===doc);
  const match = matchPr || matchAb;
  if(match){
    if(!document.getElementById('pr_nome').value) document.getElementById('pr_nome').value = match.nome||'';
    if(!document.getElementById('pr_vulgo').value) document.getElementById('pr_vulgo').value = match.vulgo||'';
    if(!document.getElementById('pr_mae').value) document.getElementById('pr_mae').value = match.nome_mae||'';
    if(!document.getElementById('pr_nasc').value) document.getElementById('pr_nasc').value = match.data_nascimento||'';
    document.getElementById('pr_autofill_flag').classList.add('show');
    toast(matchPr ? 'Já existe um mandado registrado para este documento' : 'Dados encontrados em abordagem anterior — preenchidos automaticamente', 'ok');
  } else if(!silent){
    toast('Nenhum registro anterior encontrado para este documento.');
  }
}
document.getElementById('pr_doc').addEventListener('blur', ()=>checkPrAutoFill(true));
document.getElementById('pr_btnVerificar').addEventListener('click', ()=>checkPrAutoFill(false));

document.getElementById('formProcurado').addEventListener('submit', (e)=>{
  e.preventDefault();
  if(!pr_selectedLoc){
    toast('Defina a localização conhecida do procurado (GPS, busca ou seleção no mapa).', 'err');
    return;
  }
  const id = document.getElementById('pr_id').value || uid();
  const isEdit = !!document.getElementById('pr_id').value;
  const semDoc = document.getElementById('pr_semDoc').checked;
  const item = {
    id,
    rg_cpf: semDoc ? '' : document.getElementById('pr_doc').value.trim(),
    nome: document.getElementById('pr_nome').value.trim(),
    vulgo: document.getElementById('pr_vulgo').value.trim(),
    nome_mae: document.getElementById('pr_mae').value.trim(),
    data_nascimento: document.getElementById('pr_nasc').value,
    numero_mandado: document.getElementById('pr_numero_mandado').value.trim(),
    mandado_link: document.getElementById('pr_mandado_link').value.trim(),
    artigos: document.getElementById('pr_artigos').value.trim(),
    observacoes: document.getElementById('pr_obs').value.trim(),
    endereco: document.getElementById('pr_endereco').value.trim(),
    lat: pr_selectedLoc.lat,
    lng: pr_selectedLoc.lng,
    foto: pr_photoData,
    criadoEm: isEdit ? (procurados.find(x=>x.id===id)||{}).criadoEm || nowIso() : nowIso(),
    atualizadoEm: nowIso()
  };
  if(isEdit){
    const idx = procurados.findIndex(x=>x.id===id);
    if(idx>-1) procurados[idx]=item;
  } else {
    procurados.push(item);
  }
  if(saveData(STORAGE_KEYS.procurados, procurados)){
    refreshMarkers();
    closeOverlay('overlayProcurado');
    toast(isEdit? '✅ Procurado atualizado' : '✅ Procurado registrado', 'ok');
    if(window.MDT_HOOKS && window.MDT_HOOKS.onSave) window.MDT_HOOKS.onSave('procurados', item);
  }
});

/* ============================================================
   FORMULÁRIO: LOCAL ILÍCITO
   ============================================================ */
let lo_selectedLoc = null;
let lo_photoData = null;
let lo_nivel = 'normal';

function resetLocalForm(){
  document.getElementById('formLocal').reset();
  document.getElementById('lo_id').value = '';
  document.getElementById('tituloLocal').textContent = 'Novo Local Ilícito';
  showAddrSuggestion('lo', null);
  lo_selectedLoc = null;
  lo_photoData = null;
  lo_nivel = 'normal';
  document.getElementById('lo_nivel').value = 'normal';
  document.querySelectorAll('.threat-opt').forEach(o=>o.classList.remove('active'));
  document.querySelector('.threat-opt.sel-normal').classList.add('active');
  document.getElementById('lo_photoPreview').style.display='none';
  document.getElementById('lo_photoEmpty').style.display='block';
  document.getElementById('lo_removePhoto').style.display='none';
  document.getElementById('lo_locHint').textContent = 'Nenhuma localização definida ainda.';
  document.getElementById('lo_locHint').className='field-hint';
}

function openLocalForm(editId){
  resetLocalForm();
  if(editId){
    const item = locais.find(x=>x.id===editId);
    if(!item) return;
    document.getElementById('tituloLocal').textContent = 'Editar Local Ilícito';
    document.getElementById('lo_id').value = item.id;
    document.getElementById('lo_nome').value = item.nome_local||'';
    document.getElementById('lo_endereco').value = item.endereco||'';
    lo_nivel = item.nivel_ameaca||'normal';
    document.getElementById('lo_nivel').value = lo_nivel;
    document.querySelectorAll('.threat-opt').forEach(o=>o.classList.remove('active'));
    document.querySelector(`.threat-opt.sel-${lo_nivel}`).classList.add('active');
    if(item.lat!=null && item.lng!=null){
      lo_selectedLoc = { lat:item.lat, lng:item.lng };
      setLoLocHint(true, item.endereco || 'Localização definida');
    }
    if(item.foto){
      lo_photoData = item.foto;
      document.getElementById('lo_photoPreview').src = item.foto;
      document.getElementById('lo_photoPreview').style.display='block';
      document.getElementById('lo_photoEmpty').style.display='none';
      document.getElementById('lo_removePhoto').style.display='inline';
    }
  }
  closeOverlay('archiveSheet');
  closeOverlay('personSheet');
  openOverlay('overlayLocal');
}
document.getElementById('btnNovoLocal').addEventListener('click', ()=>{ fabContainerEl.classList.remove('open'); openLocalForm(null); });

function setLoLocHint(ok, text){
  const el = document.getElementById('lo_locHint');
  el.textContent = ok ? `✅ ${text}` : `❌ ${text}`;
  el.className = 'field-hint ' + (ok?'ok':'err');
}

document.querySelectorAll('.threat-opt').forEach(opt=>{
  opt.addEventListener('click', ()=>{
    document.querySelectorAll('.threat-opt').forEach(o=>o.classList.remove('active'));
    opt.classList.add('active');
    lo_nivel = opt.dataset.val;
    document.getElementById('lo_nivel').value = lo_nivel;
  });
});

document.getElementById('lo_btnGps').addEventListener('click', async ()=>{
  if(!userLatLng){ toast('GPS ainda não disponível, aguarde o sinal.', 'err'); return; }
  lo_selectedLoc = { lat:userLatLng.lat, lng:userLatLng.lng };
  setLoLocHint(true, 'Coordenadas GPS atuais capturadas' + gpsAccuracySuffix());
  if(lastGpsAccuracy && lastGpsAccuracy > 50){
    toast(`⚠️ Sinal de GPS impreciso (±${Math.round(lastGpsAccuracy)}m). Confira o endereço ou ajuste com 🗺️ Selecionar no Mapa.`, 'err');
  }
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${userLatLng.lat}&lon=${userLatLng.lng}&zoom=18&addressdetails=1`);
    const data = await res.json();
    showAddrSuggestion('lo', formatEnderecoFromNominatim(data));
  }catch(e){ showAddrSuggestion('lo', null); }
});

document.getElementById('lo_btnBuscarEndereco').addEventListener('click', async ()=>{
  const val = document.getElementById('lo_endereco').value;
  if(!val.trim()){ toast('Digite um endereço para buscar.', 'err'); return; }
  setLoLocHint(true, 'Buscando no mapa...');
  const result = await forwardGeocode(val);
  if(result){
    lo_selectedLoc = { lat:result.lat, lng:result.lng };
    setLoLocHint(true, 'Endereço localizado no mapa');
  } else {
    setLoLocHint(false, 'Endereço não encontrado, tente ser mais específico');
  }
});

document.getElementById('lo_btnMapPick').addEventListener('click', ()=>{
  startLocationPicker('lo', 'overlayLocal');
});

document.getElementById('lo_photoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  toast('Processando foto...');
  const compressed = await compressImage(file);
  lo_photoData = compressed;
  document.getElementById('lo_photoPreview').src = compressed;
  document.getElementById('lo_photoPreview').style.display='block';
  document.getElementById('lo_photoEmpty').style.display='none';
  document.getElementById('lo_removePhoto').style.display='inline';
});
document.getElementById('lo_removePhoto').addEventListener('click', ()=>{
  lo_photoData = null;
  document.getElementById('lo_photoInput').value='';
  document.getElementById('lo_photoPreview').style.display='none';
  document.getElementById('lo_photoEmpty').style.display='block';
  document.getElementById('lo_removePhoto').style.display='none';
});

document.getElementById('formLocal').addEventListener('submit', (e)=>{
  e.preventDefault();
  if(!lo_selectedLoc){
    toast('Defina a localização do local ilícito (GPS ou busca por endereço).', 'err');
    return;
  }
  const id = document.getElementById('lo_id').value || uid();
  const isEdit = !!document.getElementById('lo_id').value;
  const item = {
    id,
    nome_local: document.getElementById('lo_nome').value.trim(),
    endereco: document.getElementById('lo_endereco').value.trim(),
    lat: lo_selectedLoc.lat,
    lng: lo_selectedLoc.lng,
    foto: lo_photoData,
    nivel_ameaca: lo_nivel,
    criadoEm: isEdit ? (locais.find(x=>x.id===id)||{}).criadoEm || nowIso() : nowIso(),
    atualizadoEm: nowIso()
  };
  if(isEdit){
    const idx = locais.findIndex(x=>x.id===id);
    if(idx>-1) locais[idx]=item;
  } else {
    locais.push(item);
  }
  if(saveData(STORAGE_KEYS.locais, locais)){
    refreshMarkers();
    closeOverlay('overlayLocal');
    toast(isEdit? '✅ Local atualizado' : '✅ Local registrado', 'ok');
    if(window.MDT_HOOKS && window.MDT_HOOKS.onSave) window.MDT_HOOKS.onSave('locais', item);
  }
});

/* ============================================================
   EXCLUSÃO
   ============================================================ */
function deleteAbordagem(id){
  if(!confirm('Excluir este registro de abordagem? Esta ação não pode ser desfeita.')) return;
  abordagens = abordagens.filter(x=>x.id!==id);
  saveData(STORAGE_KEYS.abordagens, abordagens);
  refreshMarkers();
  renderArchiveList();
  closeAnyOpenPopup();
  toast('🗑️ Registro excluído', 'ok');
  if(window.MDT_HOOKS && window.MDT_HOOKS.onDelete) window.MDT_HOOKS.onDelete('abordagens', id);
}
function deleteLocal(id){
  if(!confirm('Excluir este registro de local? Esta ação não pode ser desfeita.')) return;
  locais = locais.filter(x=>x.id!==id);
  saveData(STORAGE_KEYS.locais, locais);
  refreshMarkers();
  renderArchiveList();
  closeAnyOpenPopup();
  toast('🗑️ Registro excluído', 'ok');
  if(window.MDT_HOOKS && window.MDT_HOOKS.onDelete) window.MDT_HOOKS.onDelete('locais', id);
}
function deleteProcurado(id){
  if(!confirm('Excluir este registro de procurado? Esta ação não pode ser desfeita.')) return;
  procurados = procurados.filter(x=>x.id!==id);
  saveData(STORAGE_KEYS.procurados, procurados);
  nearbyProcuradosAlerted.delete(id);
  refreshMarkers();
  renderArchiveList();
  closeAnyOpenPopup();
  toast('🗑️ Registro excluído', 'ok');
  if(window.MDT_HOOKS && window.MDT_HOOKS.onDelete) window.MDT_HOOKS.onDelete('procurados', id);
}

/* ============================================================
   ARQUIVO (lista / localizar / editar / excluir)
   ============================================================ */
let archiveTab = 'todos';
document.getElementById('btnArquivo').addEventListener('click', ()=>{
  renderArchiveList();
  openOverlay('archiveSheet');
});
document.querySelectorAll('.tabs .tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    archiveTab = btn.dataset.tab;
    renderArchiveList();
  });
});

/* ---------------- Agrupamento de abordagens por pessoa ---------------- */
function getPersonKey(item){
  if(item.rg_cpf && item.rg_cpf.trim()) return 'doc:'+item.rg_cpf.trim().toLowerCase();
  const nome=(item.nome||'').trim().toLowerCase();
  const mae=(item.nome_mae||'').trim().toLowerCase();
  if(nome) return 'nodoc:'+nome+'|'+mae;
  return 'solo:'+item.id;
}
function getPersonGroups(){
  const map = new Map();
  abordagens.forEach(item=>{
    const key = getPersonKey(item);
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  const groups = [];
  map.forEach((occs, key)=>{
    const sorted = [...occs].sort((a,b)=>b.atualizadoEm.localeCompare(a.atualizadoEm));
    const rep = {...sorted[0]};
    ['nome','vulgo','nome_mae','data_nascimento','endereco_moradia','rg_cpf','foto'].forEach(f=>{
      if(!rep[f]){
        const found = sorted.find(x=>x[f]);
        if(found) rep[f]=found[f];
      }
    });
    rep._occorrencias = sorted;
    rep._key = key;
    groups.push(rep);
  });
  return groups.sort((a,b)=> b._occorrencias[0].atualizadoEm.localeCompare(a._occorrencias[0].atualizadoEm));
}

function buildAbordadoCard(rep){
  const card = document.createElement('div');
  card.className='arch-card';
  const count = rep._occorrencias.length;
  const thumb = rep.foto ? `<img class="thumb" src="${rep.foto}">` : `<div class="thumb placeholder">🚨</div>`;
  const title = (rep.nome || 'Não identificado') + (rep.vulgo? ` "${rep.vulgo}"`:'');
  const sub = rep._occorrencias[0].endereco_abordagem || 'Sem endereço';
  const badge = count>1 ? `<span class="badge-count">${count}×</span>` : '';
  card.innerHTML = `
    ${thumb}
    <div class="info">
      <div class="t1">${escapeHtml(title)}${badge}</div>
      <div class="t2">${escapeHtml(sub)}</div>
      <div class="t3">${fmtDateShort(rep._occorrencias[0].atualizadoEm)}</div>
    </div>
    <div class="arch-actions">
      <button class="a-loc" title="Localizar">🎯</button>
      <button class="a-profile" title="Ver Ficha">👤</button>
    </div>`;
  card.querySelector('.a-loc').onclick = ()=>{
    const withLoc = rep._occorrencias.find(o=>o.lat!=null && o.lng!=null);
    if(!withLoc){ toast('Este registro não possui localização.', 'err'); return; }
    closeOverlay('archiveSheet');
    map.flyTo({ center:[withLoc.lng, withLoc.lat], zoom:18 });
    const ref = markerRefs.ab[withLoc.id];
    if(ref) setTimeout(()=>openMarkerPopup(ref), 500);
  };
  card.querySelector('.a-profile').onclick = ()=> openPersonProfile(rep._key);
  return card;
}

function buildLocalCard(item){
  const card = document.createElement('div');
  card.className='arch-card';
  const thumb = item.foto ? `<img class="thumb" src="${item.foto}">` : `<div class="thumb placeholder">${item.nivel_ameaca==='alto'?'☠️':'🏚️'}</div>`;
  const title = item.nome_local || 'Local sem nome';
  const sub = item.endereco || 'Sem endereço';
  const badge = item.nivel_ameaca==='alto' ? '<span class="badge-alto">ALTO RISCO</span>' : '';
  card.innerHTML = `
    ${thumb}
    <div class="info">
      <div class="t1">${escapeHtml(title)}${badge}</div>
      <div class="t2">${escapeHtml(sub)}</div>
      <div class="t3">${fmtDateShort(item.atualizadoEm)}</div>
    </div>
    <div class="arch-actions">
      <button class="a-loc" title="Localizar">🎯</button>
      <button class="a-edit" title="Editar">✏️</button>
      <button class="a-del" title="Excluir">🗑️</button>
    </div>`;
  card.querySelector('.a-loc').onclick = ()=>{
    if(item.lat==null||item.lng==null){ toast('Este registro não possui localização.', 'err'); return; }
    closeOverlay('archiveSheet');
    map.flyTo({ center:[item.lng, item.lat], zoom:18 });
    const ref = markerRefs.lo[item.id];
    if(ref) setTimeout(()=>openMarkerPopup(ref), 500);
  };
  card.querySelector('.a-edit').onclick = ()=> openLocalForm(item.id);
  card.querySelector('.a-del').onclick = ()=> deleteLocal(item.id);
  return card;
}

function buildProcuradoCard(item){
  const card = document.createElement('div');
  card.className='arch-card';
  const thumb = item.foto ? `<img class="thumb" src="${item.foto}">` : `<div class="thumb placeholder">🚓</div>`;
  const title = (item.nome || 'Não identificado') + (item.vulgo? ` "${item.vulgo}"`:'');
  const sub = item.endereco || 'Sem endereço';
  const badge = '<span class="badge-alto">PROCURADO</span>';
  card.innerHTML = `
    ${thumb}
    <div class="info">
      <div class="t1">${escapeHtml(title)}${badge}</div>
      <div class="t2">${escapeHtml(sub)}</div>
      <div class="t3">${item.numero_mandado ? 'Mandado: '+escapeHtml(item.numero_mandado) : fmtDateShort(item.atualizadoEm)}</div>
    </div>
    <div class="arch-actions">
      <button class="a-loc" title="Localizar">🎯</button>
      <button class="a-edit" title="Editar">✏️</button>
      <button class="a-del" title="Excluir">🗑️</button>
    </div>`;
  card.querySelector('.a-loc').onclick = ()=>{
    if(item.lat==null||item.lng==null){ toast('Este registro não possui localização.', 'err'); return; }
    closeOverlay('archiveSheet');
    map.flyTo({ center:[item.lng, item.lat], zoom:18 });
    const ref = markerRefs.pr[item.id];
    if(ref) setTimeout(()=>openMarkerPopup(ref), 500);
  };
  card.querySelector('.a-edit').onclick = ()=> openProcuradoForm(item.id);
  card.querySelector('.a-del').onclick = ()=> deleteProcurado(item.id);
  return card;
}

function renderArchiveList(){
  const list = document.getElementById('archList');
  list.innerHTML = '';

  if(archiveTab==='abordados'){
    const groups = getPersonGroups();
    if(groups.length===0){ list.innerHTML = `<div class="arch-empty">Nenhum registro de abordagem salvo ainda.</div>`; return; }
    groups.forEach(rep=> list.appendChild(buildAbordadoCard(rep)));
  } else if(archiveTab==='locais'){
    const data = [...locais].sort((a,b)=>b.atualizadoEm.localeCompare(a.atualizadoEm));
    if(data.length===0){ list.innerHTML = `<div class="arch-empty">Nenhum registro de local ilícito salvo ainda.</div>`; return; }
    data.forEach(item=> list.appendChild(buildLocalCard(item)));
  } else if(archiveTab==='procurados'){
    const data = [...procurados].sort((a,b)=>b.atualizadoEm.localeCompare(a.atualizadoEm));
    if(data.length===0){ list.innerHTML = `<div class="arch-empty">Nenhum procurado registrado ainda.</div>`; return; }
    data.forEach(item=> list.appendChild(buildProcuradoCard(item)));
  } else {
    const groups = getPersonGroups().map(rep=>({ type:'ab', date: rep._occorrencias[0].atualizadoEm, rep }));
    const locs = locais.map(item=>({ type:'lo', date: item.atualizadoEm, item }));
    const wanted = procurados.map(item=>({ type:'pr', date: item.atualizadoEm, item }));
    const combined = [...groups, ...locs, ...wanted].sort((a,b)=> b.date.localeCompare(a.date));
    if(combined.length===0){ list.innerHTML = `<div class="arch-empty">Nenhum registro salvo ainda.</div>`; return; }
    combined.forEach(entry=>{
      const card = entry.type==='ab' ? buildAbordadoCard(entry.rep) : entry.type==='pr' ? buildProcuradoCard(entry.item) : buildLocalCard(entry.item);
      list.appendChild(card);
    });
  }
}

/* ---------------- Ficha da Pessoa (histórico de abordagens) ---------------- */
function openPersonProfile(key){
  const rep = getPersonGroups().find(g=>g._key===key);
  if(!rep) return;
  document.getElementById('personTitulo').textContent = rep.nome || 'Não identificado';
  const photoBlock = rep.foto ? `<img src="${rep.foto}">` : `<div class="ph-placeholder">🚨</div>`;
  document.getElementById('personData').innerHTML = `
    <div class="person-photo-row">
      ${photoBlock}
      <div class="person-info-block">
        <div class="p-name">${escapeHtml(rep.nome)||'Não identificado'}</div>
        ${rep.vulgo? `<div class="p-vulgo">"${escapeHtml(rep.vulgo)}"</div>`:''}
        <div class="person-field"><b>Doc:</b> ${escapeHtml(rep.rg_cpf)||'Sem documento'}</div>
        <div class="person-field"><b>Mãe:</b> ${escapeHtml(rep.nome_mae)||'—'}</div>
        <div class="person-field"><b>Nasc:</b> ${rep.data_nascimento||'—'}</div>
        <div class="person-field"><b>Moradia:</b> ${escapeHtml(rep.endereco_moradia)||'—'}</div>
      </div>
    </div>`;
  document.getElementById('personOccCount').textContent = rep._occorrencias.length;
  const occList = document.getElementById('personOccList');
  occList.innerHTML = '';
  rep._occorrencias.forEach(occ=>{
    const card = document.createElement('div');
    card.className='arch-card';
    const thumb = occ.foto ? `<img class="thumb" src="${occ.foto}">` : `<div class="thumb placeholder">🚨</div>`;
    const artigosTxt = occ.artigos ? escapeHtml(occ.artigos) : 'Sem artigos registrados';
    card.innerHTML = `
      ${thumb}
      <div class="info">
        <div class="t1">${fmtDateShort(occ.atualizadoEm)}</div>
        <div class="t2">${escapeHtml(occ.endereco_abordagem)||'Sem endereço'}</div>
        <div class="t3">${artigosTxt}</div>
      </div>
      <div class="arch-actions">
        <button class="a-loc" title="Localizar">🎯</button>
        <button class="a-edit" title="Editar">✏️</button>
        <button class="a-del" title="Excluir">🗑️</button>
      </div>`;
    card.querySelector('.a-loc').onclick = ()=>{
      if(occ.lat==null||occ.lng==null){ toast('Este registro não possui localização.', 'err'); return; }
      closeOverlay('personSheet'); closeOverlay('archiveSheet');
      map.flyTo({ center:[occ.lng, occ.lat], zoom:18 });
      const ref = markerRefs.ab[occ.id];
      if(ref) setTimeout(()=>openMarkerPopup(ref), 500);
    };
    card.querySelector('.a-edit').onclick = ()=> openAbordagemForm(occ.id);
    card.querySelector('.a-del').onclick = ()=>{
      if(!confirm('Excluir esta abordagem? Esta ação não pode ser desfeita.')) return;
      abordagens = abordagens.filter(x=>x.id!==occ.id);
      saveData(STORAGE_KEYS.abordagens, abordagens);
      refreshMarkers();
      const stillExists = abordagens.some(x=>getPersonKey(x)===key);
      if(stillExists){ openPersonProfile(key); } else { closeOverlay('personSheet'); }
      renderArchiveList();
      toast('🗑️ Registro excluído', 'ok');
    };
    occList.appendChild(card);
  });
  closeOverlay('archiveSheet');
  openOverlay('personSheet');
}

/* ============================================================
   Inicialização
   ============================================================ */
refreshMarkers();
toast('MDT Tático inicializado', 'ok');

/* ============================================================
   Interface pública para o auth-sync.js (sincronização Supabase)
   ============================================================ */
window.MDT = {
  getAbordagens: ()=>abordagens,
  getLocais: ()=>locais,
  getProcurados: ()=>procurados,
  replaceAbordagens: (arr)=>{ abordagens = arr; saveData(STORAGE_KEYS.abordagens, abordagens); refreshMarkers(); renderArchiveList(); },
  replaceLocais: (arr)=>{ locais = arr; saveData(STORAGE_KEYS.locais, locais); refreshMarkers(); renderArchiveList(); },
  replaceProcurados: (arr)=>{ procurados = arr; saveData(STORAGE_KEYS.procurados, procurados); refreshMarkers(); renderArchiveList(); },
  toast
};

})();

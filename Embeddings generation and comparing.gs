/***********************************************
 * =============== Helpers  =============
 ***********************************************/

// ====== CONFIGURABLE (Script Properties) ======
// Script Properties sugeridas:
//  - SHEET_ID
//  - GEMINI_API_KEY
//  - EMBEDDING_MODEL         (p.ej. "text-embedding-004" o "embedding-001")
//  - EMBEDDING_DIM           (p.ej. 3072)
//  - BATCH_LIMIT             (p.ej. 32)
//  - BATCH_SLEEP_MS          (p.ej. 500)

var DEFAULTS = {
  EMBEDDING_MODEL : PropertiesService.getScriptProperties().getProperty('EMBEDDING_MODEL')  || 'embedding-001',
  EMBEDDING_DIM   : Number(PropertiesService.getScriptProperties().getProperty('EMBEDDING_DIM') || 3072),
  BATCH_LIMIT     : Number(PropertiesService.getScriptProperties().getProperty('BATCH_LIMIT')   || 32),
  BATCH_SLEEP_MS  : Number(PropertiesService.getScriptProperties().getProperty('BATCH_SLEEP_MS')|| 500)
};

// === Acceso seguro a Spreadsheet por ID ===
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Falta SHEET_ID en Script Properties.');
  return SpreadsheetApp.openById(id);
}

// === Acceso a la API Key (nunca versionar en código) ===
function getGeminiApiKey() {
  var sp = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var up = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');
  var key = (sp && sp.trim()) || (up && up.trim());
  if (!key) throw new Error('Falta GEMINI_API_KEY en Script/User Properties.');
  return key;
}

// === Utilidades de texto / limpieza ===
function _toStr_(x){ return (x == null ? '' : String(x)).trim(); }
function _oneLine_(t){ return (t || '').replace(/\r?\n+/g, ' ').replace(/\s+/g,' ').trim(); }
function _normalizeSpaces_(t){ return (t || '').replace(/\s+/g,' ').trim(); }
function _minLenOrNull_(t, min){ t=_toStr_(t); return t.length >= (min||1) ? t : null; }
function _clip_(s, max){ s = _toStr_(s); return s.length > max ? (s.slice(0, max-1) + '…') : s; }

// === Distancia / similitud ===
function dot_(a, b) {
  var len = Math.min(a.length, b.length), s = 0;
  for (var i=0;i<len;i++) s += (Number(a[i])||0) * (Number(b[i])||0);
  return s;
}
function L2norm_(v) {
  var s=0; for (var i=0;i<v.length;i++){ var x=Number(v[i])||0; s += x*x; }
  return Math.sqrt(s);
}
function cosine_(a, b) {
  var na = L2norm_(a), nb = L2norm_(b);
  if (na === 0 || nb === 0) return 0;
  var sim = dot_(a,b)/(na*nb);
  return Math.max(-1, Math.min(1, sim));
}

// === Batch embeddings (interfaz) ===
// Implementación de ejemplo con UrlFetchApp; ajusta al proveedor real.
// Retorna: Array<Array<number>> con dimensión fija (DEFAULTS.EMBEDDING_DIM)
function batchEmbedContents_(apiKey, texts, outDim) {
  if (!texts || !texts.length) return [];
  // Limpieza básica previa (reduce ruido y tokens)
  var cleaned = texts.map(function(t){ return _oneLine_(_normalizeSpaces_(t)); });

  // *** INTERFAZ ****
  // Aquí deberías llamar a tu servicio de embeddings (Vertex, Gemini, etc.).
  // Para portafolio, dejamos estructura genérica y validaciones.
  // throw new Error('Implementa la llamada a tu servicio de embeddings.');

  // --- MOCK SAFE para demo de portafolio ---
  // IMPORTANTE: En producción, elimina este bloque mock.
  var dim = outDim || DEFAULTS.EMBEDDING_DIM;
  var out = new Array(cleaned.length);
  for (var i=0;i<cleaned.length;i++){
    var v = new Array(dim);
    for (var d=0; d<dim; d++) v[d] = 0; // coloca ceros para no filtrar secretos
    out[i] = v;
  }
  return out;
  // --- /MOCK ---
}

/****************************************************
 * =========== Embeddings cliente (generación) =======
 * Lee "skills_client_enriched" y escribe "embeddings_client"
 ****************************************************/

// Hojas estándar (anónimas)
var SHEET_SKILLS_ENRICHED = 'skills_client_enriched';  // antes: Habilidades_Mejorada_Cliente
var SHEET_EMB_CLIENT      = 'embeddings_client';

function generarEmbeddingsCliente() {
  var apiKey = getGeminiApiKey();
  var ss = getSpreadsheet_();

  // Entrada
  var inSh = ss.getSheetByName(SHEET_SKILLS_ENRICHED);
  if (!inSh) throw new Error('No existe la hoja "' + SHEET_SKILLS_ENRICHED + '".');

  var vals = inSh.getDataRange().getValues();
  if (!vals || vals.length < 2) throw new Error('Se requiere encabezado + al menos 1 fila de datos.');

  // Detección flexible de encabezados
  var header = vals[0].map(function(c){ return _toStr_(c).toLowerCase(); });
  var iName = header.findIndex(function(h){ return h.includes('habilidad') || h.includes('competencia'); });
  var iDef  = header.findIndex(function(h){ return h.includes('definición mejorada') || h.includes('definicion mejorada') || h.includes('definition'); });
  if (iName === -1 || iDef === -1) {
    throw new Error('Encabezados no detectados. Se esperan columnas "Habilidad" y "Definición mejorada (IA)".');
  }

  // Filtrar filas válidas (mínima longitud para evitar ruido)
  var rowsAll = vals.slice(1);
  var rows = [];
  for (var r=0; r<rowsAll.length; r++) {
    var name = _minLenOrNull_(rowsAll[r][iName], 2);
    var defn = _minLenOrNull_(rowsAll[r][iDef] , 10);
    if (name && defn) rows.push([name, defn]);
  }
  if (!rows.length) throw new Error('No hay filas válidas con Habilidad y Definición (minLen aplicado).');

  // Salida
  var outSh = ss.getSheetByName(SHEET_EMB_CLIENT) || ss.insertSheet(SHEET_EMB_CLIENT);
  outSh.clearContents();
  outSh.setFrozenRows(1);

  // Preparar textos concatenados
  var textos = rows.map(function(rr){ return 'Habilidad: ' + rr[0] + '. Definición: ' + rr[1]; });

  var processed = 0;
  var BATCH_LIMIT    = DEFAULTS.BATCH_LIMIT;
  var BATCH_SLEEP_MS = DEFAULTS.BATCH_SLEEP_MS;
  var OUT_DIM        = DEFAULTS.EMBEDDING_DIM;

  for (var start = 0; start < textos.length; start += BATCH_LIMIT) {
    var end = Math.min(start + BATCH_LIMIT, textos.length);
    var chunkTexts = textos.slice(start, end);

    var vectors = batchEmbedContents_(apiKey, chunkTexts, OUT_DIM);
    if (!vectors || !vectors.length) throw new Error('El servicio de embeddings devolvió vacío.');

    // Header dinámico la 1ª vez
    if (processed === 0) {
      var dim = vectors[0].length;
      var headerOut = ['Habilidad', 'Definición'];
      for (var d=0; d<dim; d++) headerOut.push('d' + (d+1));
      outSh.getRange(1, 1, 1, headerOut.length).setValues([headerOut]);
    }

    // Construir filas y escribir en bloque
    var rowsOut = [];
    for (var i=0; i<vectors.length; i++) {
      var orig = rows[start + i];
      rowsOut.push([ orig[0], orig[1] ].concat(vectors[i]));
    }
    outSh.getRange(2 + processed, 1, rowsOut.length, rowsOut[0].length).setValues(rowsOut);

    processed += vectors.length;
    Utilities.sleep(BATCH_SLEEP_MS);
  }

  return 'Embeddings cliente generados. Filas procesadas: ' + processed +
         '. Dimensión: ' + DEFAULTS.EMBEDDING_DIM + '.';
}
/*********************************************************
 * === Comparación cliente vs catálogo interno (Top-K) ===
 * Lee "embeddings_client" y "embeddings_internal"
 * Escribe "catalog_skills" con Top-K + promedio
 *********************************************************/

var SHEET_EMB_CLIENT   = 'embeddings_client';
var SHEET_EMB_INTERNAL = 'embeddings_internal'; // antes: Embeddings UBITS
var SHEET_OUTPUT       = 'catalog_skills';      // antes: Catalogo_Habilidades

// ===== CONFIGURABLE =====
var TOP_K            = 3;
var MIN_SIMILARITY   = 0.65; // 0..1
var PERCENT_DECIMALS = 2;
// ========================

function compararClienteConCatalogo() {
  var ss = getSpreadsheet_();
  var clientSh = ss.getSheetByName(SHEET_EMB_CLIENT);
  var internalSh  = ss.getSheetByName(SHEET_EMB_INTERNAL);
  if (!clientSh)  throw new Error('No se encontró la hoja "' + SHEET_EMB_CLIENT   + '".');
  if (!internalSh)throw new Error('No se encontró la hoja "' + SHEET_EMB_INTERNAL + '".');

  var client = readEmbeddingsSheet_(clientSh);
  var internal  = readEmbeddingsSheet_(internalSh);

  if (client.rows === 0)  throw new Error('La hoja "' + SHEET_EMB_CLIENT   + '" no tiene filas válidas.');
  if (internal.rows === 0)throw new Error('La hoja "' + SHEET_EMB_INTERNAL + '" no tiene filas válidas.');

  // Alinear dimensiones usando la mínima
  var dimUsed = Math.min(client.dim, internal.dim);
  if (client.dim !== internal.dim) {
    client.vecs   = client.vecs.map(function(v){ return v.slice(0, dimUsed); });
    internal.vecs = internal.vecs.map(function(v){ return v.slice(0, dimUsed); });
  }

  // Precalcular normas del catálogo (para rendimiento)
  var internalNorms = internal.vecs.map(L2norm_);
  var baseCount = internal.vecs.length;

  // Preparar salida
  var outSh = ss.getSheetByName(SHEET_OUTPUT) || ss.insertSheet(SHEET_OUTPUT);
  outSh.clearContents();

  // Headers visibles (sin definiciones en columnas)
  var headers = ['Habilidad cliente'];
  for (var k=1; k<=TOP_K; k++) {
    headers.push('Match ' + k + ' (Catálogo)');
    headers.push('Sim ' + k + ' (%)');
  }
  headers.push('Promedio (%)');
  outSh.appendRow(headers);

  var results = [];
  var clientDefs = []; // descripciones cliente para comentarios
  var internalDefsMap = {}; // nombre -> descripción
  internal.names.forEach(function(n, idx){ internalDefsMap[n] = internal.defs[idx]; });

  var globalSumOfAverages = 0;

  for (var i=0; i<client.rows; i++) {
    var cName = client.names[i];
    var cDef  = client.defs[i];
    var cVec  = client.vecs[i];
    var cNorm = L2norm_(cVec);

    clientDefs.push(cDef);

    if (cNorm === 0) {
      var emptyRow = [cName];
      for (var e=0; e<TOP_K; e++) emptyRow.push('-', '-');
      emptyRow.push('-');
      results.push(emptyRow);
      continue;
    }

    // Similitudes contra TODO el catálogo
    var sims = new Array(baseCount);
    for (var j=0; j<baseCount; j++) {
      var sim = internalNorms[j] === 0 ? 0 : dot_(cVec, internal.vecs[j])/(cNorm*internalNorms[j]);
      // clamp seguridad
      if (sim > 1) sim = 1;
      if (sim < -1) sim = -1;
      sims[j] = { name: internal.names[j], def: internal.defs[j], sim: sim };
    }

    // Ordenar descendente por similitud (para N grande puedes usar selección parcial)
    sims.sort(function(a,b){ return b.sim - a.sim; });

    var topSims = sims.slice(0, TOP_K).map(function(s){ return s.sim; });
    var validSims = topSims.filter(function(s){ return s >= MIN_SIMILARITY; });
    var avgTop = validSims.length ? (validSims.reduce(function(a,b){return a+b;}, 0)/validSims.length) : 0;
    globalSumOfAverages += avgTop;

    var row = [cName];
    for (var kk=0; kk<TOP_K; kk++) {
      var cand = sims[kk];
      if (!cand || cand.sim < MIN_SIMILARITY) row.push('-', '-');
      else row.push(cand.name, (cand.sim*100).toFixed(PERCENT_DECIMALS) + '%');
    }
    row.push((avgTop*100).toFixed(PERCENT_DECIMALS) + '%');
    results.push(row);
  }

  if (results.length) {
    outSh.getRange(2, 1, results.length, headers.length).setValues(results);
  }

  // Comentarios: definiciones cliente + catálogo
  for (var r=0; r<results.length; r++) {
    var rowVals = results[r];
    // comentario cliente
    outSh.getRange(r+2, 1).setComment(_clip_(clientDefs[r], 2000));
    // comentarios Top-K
    for (var k=0; k<TOP_K; k++) {
      var ubCol = 2 + (k*2);     // columna nombre match
      var name  = rowVals[ubCol-1];
      if (name && name !== '-') {
        var def = internalDefsMap[name];
        if (def) outSh.getRange(r+2, ubCol).setComment(_clip_(def, 2000));
      }
    }
  }

  // Fila resumen
  var overallAvg = results.length ? (globalSumOfAverages / results.length) : 0;
  var summaryRow = new Array(headers.length).fill('');
  summaryRow[summaryRow.length - 1] = 'PROMEDIO GENERAL: ' + (overallAvg*100).toFixed(PERCENT_DECIMALS) + '%';
  outSh.appendRow(summaryRow);

  outSh.setFrozenRows(1);
  outSh.autoResizeColumns(1, headers.length);

  return 'Comparación completada. Filas: ' + results.length + '. Dimensión usada: ' + dimUsed + '.';
}

/* ----------- Lectura genérica de hojas de embeddings ----------- */
function readEmbeddingsSheet_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return { rows: 0, dim: 0, names: [], defs: [], vecs: [] };

  var numCols = values[0].length;
  var dim = Math.max(0, numCols - 2);

  // Filtra filas con nombre + definición y al menos 1 componente numérico
  var body = values.slice(1).filter(function(r){
    if (!r[0] || !r[1]) return false;
    for (var d=0; d<dim; d++) {
      var raw = r[2+d];
      if (raw == null) continue;
      var num = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(',', '.'));
      if (!isNaN(num)) return true;
    }
    return false;
  });

  var names = new Array(body.length);
  var defs  = new Array(body.length);
  var vecs  = new Array(body.length);

  for (var i=0; i<body.length; i++) {
    var row = body[i];
    names[i] = _toStr_(row[0]);
    defs[i]  = _toStr_(row[1]);
    var v = new Array(dim);
    for (var d=0; d<dim; d++) {
      var val = row[2 + d];
      var num = (typeof val === 'number') ? val : parseFloat(String(val).replace(',', '.'));
      v[d] = isNaN(num) ? 0 : num;
    }
    vecs[i] = v;
  }
  return { rows: body.length, dim: dim, names: names, defs: defs, vecs: vecs };
}


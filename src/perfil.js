import fs from "node:fs";
import path from "node:path";
import { cargarPerfilMaestro, datoDePortal, resolverArchivo } from "./perfil-maestro.js";
import { ARCHIVO_CATALOGOS, CARPETA_RESPALDOS, PORTAL } from "./config.js";
import { atributoData, decodificarHtml, paramEstiloJquery, pedir, pedirJson, tokenDeFormulario, SesionExpirada } from "./http.js";
import { rangoSalario } from "./ofertas.js";

const HDV = "/co/hoja-de-vida";

const normalizar = (t) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ---------------------------------------------------------------- página y catálogos */

async function paginaHojaDeVida() {
  const r = await pedir(HDV);
  if (!/js-form-laboral-experience/.test(r.texto)) throw new SesionExpirada();
  return r.texto;
}

const NOMBRES_CATALOGO = {
  paises: "data-countries",
  ciudades: "data-cities",
  cargos: "data-position-structures",
  areas_cursos: "data-course-areas",
  instituciones: "data-institutes",
  profesiones: "data-professions",
  habilidades: "data-skills",
  sectores: "data-company-sector",
};

export async function catalogos({ forzar = false, html = null } = {}) {
  if (!forzar && fs.existsSync(ARCHIVO_CATALOGOS)) {
    const c = JSON.parse(fs.readFileSync(ARCHIVO_CATALOGOS, "utf8"));
    if (Date.now() - c._fecha < 7 * 24 * 3600 * 1000) return c;
  }
  const pagina = html || (await paginaHojaDeVida());
  const c = { _fecha: Date.now() };
  for (const [clave, atributo] of Object.entries(NOMBRES_CATALOGO)) {
    const crudo = atributoData(pagina, atributo);
    c[clave] = crudo ? JSON.parse(crudo).map(({ id, name }) => ({ id, name })) : [];
  }
  fs.mkdirSync(path.dirname(ARCHIVO_CATALOGOS), { recursive: true });
  fs.writeFileSync(ARCHIVO_CATALOGOS, JSON.stringify(c));
  return c;
}

/** Elige del catálogo la entrada que mejor coincide con alguno de los textos (en orden de preferencia). */
function elegir(lista, preferencias) {
  for (const pref of preferencias) {
    const p = normalizar(pref);
    const exacta = lista.find((x) => normalizar(x.name) === p);
    if (exacta) return exacta;
    const empieza = lista.find((x) => normalizar(x.name).startsWith(p));
    if (empieza) return empieza;
    const contiene = lista.find((x) => normalizar(x.name).includes(p));
    if (contiene) return contiene;
  }
  return null;
}

const CONECTORES = new Set(["de", "del", "la", "las", "los", "el", "en", "y", "e", "o", "a", "con", "para", "por", "the", "of", "and", "in", "for"]);
const palabras = (t) => normalizar(t).split(" ").filter((p) => p.length >= 2 && !CONECTORES.has(p));

/** Entrada del catálogo que comparte más palabras con alguno de los textos; null si ninguna comparte. */
function masParecido(lista, textos) {
  let mejor = null;
  let puntos = 0;
  for (const texto of textos.filter(Boolean)) {
    const buscadas = new Set(palabras(texto));
    for (const x of lista) {
      const p = palabras(x.name).filter((w) => buscadas.has(w)).length;
      if (p > puntos || (p === puntos && p > 0 && x.name.length < mejor.name.length)) {
        mejor = x;
        puntos = p;
      }
    }
  }
  return mejor;
}

/** Ciudad del catálogo ("Cali, Valle Del Cauca, Colombia") a partir de un texto como "Cali, Colombia" o "Yumbo". */
function elegirCiudad(ciudades, texto) {
  const partes = String(texto || "").split(",").map(normalizar).filter(Boolean);
  if (!partes.length) return null;
  const candidatas = ciudades.filter((c) => normalizar(c.name.split(",")[0]) === partes[0]);
  if (candidatas.length <= 1) return candidatas[0] || null;
  return candidatas.find((c) => partes.slice(1).some((p) => normalizar(c.name).includes(p))) || candidatas[0];
}

/* ---------------------------------------------------------------- lectura */

function idsPorSeccion(html) {
  const secciones = {};
  const marcas = [...html.matchAll(/id="(experiencia-laboral|estudios-formales|estudios-no-formales|languages|seguridad-social)"/g)].map((m) => ({
    seccion: m[1],
    pos: m.index,
  }));
  for (const m of html.matchAll(/class="module-summary js-module-summary"[^>]*data-id="(\d+)"|data-id="(\d+)"[^>]*class="module-summary js-module-summary"/g)) {
    const id = Number(m[1] || m[2]);
    const marca = marcas.filter((x) => x.pos < m.index).pop();
    if (!marca) continue;
    (secciones[marca.seccion] ||= []).push(id);
  }
  return secciones;
}

const fecha = (iso) => (iso ? iso.slice(0, 7) : null);

export async function verMiPerfil() {
  const html = await paginaHojaDeVida();
  const ids = idsPorSeccion(html);
  const [pp, adj, redes, habilidades] = await Promise.all([
    pedirJson("/co/Persons/ProfessionalProfile/Get"),
    pedirJson("/co/Persons/Attachment/Get"),
    pedirJson("/co/Persons/SocialNetwork/Get"),
    pedirJson("/co/Persons/Skills/Get"),
  ]);

  const experiencia = [];
  for (const id of ids["experiencia-laboral"] || []) {
    const r = (await pedirJson(`/co/Persons/LaboralExperience/Get?id=${id}`)).result;
    experiencia.push({
      id,
      cargo: r.position,
      empresa: r.companyName,
      cargo_equivalente: r.equivalentPositionStructureName,
      sector: r.companySectorName,
      ciudad: r.cityName,
      inicio: fecha(r.startDate),
      fin: r.isCurrentlyWorking ? null : fecha(r.endDate),
      actual: r.isCurrentlyWorking,
      logros: r.achievements,
      completa: r.isCompleted,
    });
  }

  const formacion = [];
  for (const id of ids["estudios-formales"] || []) {
    const r = (await pedirJson(`/co/Persons/FormalEducation/Get?id=${id}`)).result;
    formacion.push({
      id,
      titulo: r.degree,
      nivel_id: r.educationLevels?.selectedId,
      institucion: r.instituteName || r.otherInstitute || r.instituteIdName || null,
      inicio: fecha(r.startDate),
      fin: fecha(r.endDate),
      estado_id: r.educationStatus?.selectedIds?.[0] ?? r.educationStatus?.selectedId ?? null,
    });
  }

  const cursos = [];
  for (const id of ids["estudios-no-formales"] || []) {
    const r = (await pedirJson(`/co/Persons/NonFormalEducation/Get?id=${id}`)).result;
    cursos.push({ id, nombre: r.name, institucion: r.institute, inicio: fecha(r.startDate), fin: fecha(r.endDate) });
  }

  const idiomas = [];
  for (const id of ids["languages"] || []) {
    const r = (await pedirJson(`/co/Persons/LanguageKnowledge/Get?id=${id}`)).result;
    const k = Number(r.knowledge);
    idiomas.push({ id, idioma_id: r.language?.id, idioma: r.language?.name, nivel: k <= 40 ? "Básico" : k <= 70 ? "Intermedio" : "Avanzado" });
  }

  const p = pp.result || {};
  return {
    estado_hoja_de_vida: pp.resumeInfo?.indicator?.statusText || null,
    ultima_actualizacion: pp.resumeInfo?.lastUpdate || null,
    completitud: pp.progressBar?.completePercent ?? null,
    perfil_profesional: {
      profesion: p.professionName?.trim(),
      profesion_id: p.professionId,
      texto: p.profile,
      anios_experiencia: p.experienceYears?.selectedIds?.[0] ?? null,
      aspiracion_salarial: p.salaryName,
      puede_mudarse: p.canMove,
      puede_viajar: p.canTravel,
      paises: (p.workCountries || []).map((c) => c.name),
    },
    experiencia,
    formacion,
    cursos,
    idiomas,
    redes_sociales: (redes.userSocialNetworks || []).map((r) => ({ id: r.id, red: r.name || r.value, url: r.url || r.sharedUrl })),
    habilidades: (habilidades.skills || []).map((s) => s.name),
    archivos: (adj.result?.files || []).map((f) => ({ id: f.id, nombre: f.name, url: f.url })),
    enlaces: (adj.result?.links || []).map((l) => ({ id: l.id, url: l.url })),
    limites_archivos: { maximo: adj.result?.maxAttachments, megas: adj.result?.amountMegabytesAllowed },
  };
}

export async function listarMisCv() {
  const adj = await pedirJson("/co/Persons/Attachment/Get");
  return {
    archivos: (adj.result?.files || []).map((f) => ({ id: f.id, nombre: f.name, url: f.url })),
    maximo: adj.result?.maxAttachments,
    megas_por_archivo: adj.result?.amountMegabytesAllowed,
    nota: "En la postulación rápida se elige cuál de estos archivos recibe la empresa.",
  };
}

/* ---------------------------------------------------------------- objetivo desde el perfil maestro */

const ddmmyyyy = (yyyyMm, dia = "01") => {
  if (!yyyyMm) return "";
  const [y, m = "01"] = String(yyyyMm).split("-");
  return `${dia}/${m.padStart(2, "0")}/${y}`;
};

function aniosTotales(maestro) {
  const inicios = (maestro.experiencia || []).map((e) => e.inicio).filter(Boolean).sort();
  if (!inicios.length) return null;
  const [y, m] = inicios[0].split("-").map(Number);
  const ahora = new Date();
  return Math.floor((ahora.getFullYear() * 12 + ahora.getMonth() + 1 - (y * 12 + m)) / 12);
}

function textoLogros(e) {
  const lineas = [];
  if (e.descripcion_empresa) lineas.push(e.descripcion_empresa + (e.modalidad ? ` · ${e.modalidad}` : "") + (e.tipo_contrato ? ` · ${e.tipo_contrato}` : ""));
  for (const l of e.logros_es || []) lineas.push(`• ${l}`);
  if (e.tecnologias?.length) lineas.push(`Tecnologías: ${e.tecnologias.join(", ")}`);
  let t = lineas.join("\n");
  if (t.length > 2000) t = t.slice(0, 1995) + "…";
  return t;
}

const PALABRAS_VACIAS = new Set(["varias", "empresas", "incl", "group", "grupo", "sas", "ltda", "inc", "llc", "corp", "com", "dev", "the"]);

function clavesEmpresa(nombre, pais = "") {
  const vacias = new Set([...PALABRAS_VACIAS, ...normalizar(pais).split(" ")]);
  return normalizar(nombre)
    .split(" ")
    .filter((p) => p.length >= 3 && !vacias.has(p));
}

function mismaEmpresa(nombreElempleo, claves) {
  const n = normalizar(nombreElempleo);
  return claves.some((c) => n.includes(c));
}

function mismoEstudio(a, b) {
  const raices = (t) => new Set(normalizar(t).split(" ").filter((p) => p.length > 3).map((p) => p.slice(0, 6)));
  const ra = raices(a);
  return [...raices(b)].filter((r) => ra.has(r)).length >= 2;
}

/** Ciudad de residencia del perfil maestro, usada cuando una entrada no indica la suya. */
const ciudadBase = (maestro, cat) => elegirCiudad(cat.ciudades, [maestro.datos_personales?.ciudad, maestro.datos_personales?.pais].filter(Boolean).join(", "));

/** Dato propio de elempleo en una entrada del perfil maestro (portales.elempleo.<campo>). */
const deElempleo = (entrada, campo) => datoDePortal(entrada, PORTAL, campo);

// Cada entrada puede fijar en portales.elempleo el nombre exacto del catálogo (cargo_equivalente,
// sector, ciudad, area, nucleo_conocimiento); si no, se elige la opción que más palabras comparte.
function objetivoExperiencia(maestro, cat) {
  const base = ciudadBase(maestro, cat);
  return (maestro.experiencia || []).map((e) => ({
    claves: clavesEmpresa(e.empresa, maestro.datos_personales?.pais),
    empresa: e.empresa,
    cargo: e.cargo_oficial ? `${e.cargo} (cargo oficial: ${e.cargo_oficial})` : e.cargo,
    cargo_equivalente: (deElempleo(e, "cargo_equivalente") && elegir(cat.cargos, [deElempleo(e, "cargo_equivalente")])) || masParecido(cat.cargos, [e.cargo, e.cargo_oficial, e.cargo_en]),
    sector: (deElempleo(e, "sector") && elegir(cat.sectores, [deElempleo(e, "sector")])) || masParecido(cat.sectores, [e.descripcion_empresa]),
    ciudad: elegirCiudad(cat.ciudades, deElempleo(e, "ciudad") || e.ubicacion) || base,
    inicio: e.inicio,
    fin: e.fin,
    logros: textoLogros(e),
  }));
}

const NIVELES_EDUCACION = [
  [/doctor|phd/, "Doctorado"],
  [/maestr|magist|master|m\.?sc/, "Maestría"],
  [/especializ/, "Especialización"],
  [/tecnico profesional/, "Formación Tec profesional"],
  [/tecnolog/, "Tecnológica"],
  [/tecnic/, "Técnico Laboral"],
  [/bachiller|media/, "Media (10° - 13°)"],
  [/ingenier|licenciad|profesional|pregrado|grado|bachelor|b\.?sc|administra|economi|derecho|medicin|contad|psicolog|arquitect/, "Universitaria"],
];

function nivelEducativo(f) {
  if (f.nivel) return f.nivel;
  const t = normalizar(`${f.titulo_es || ""} ${f.titulo_en || ""}`);
  return NIVELES_EDUCACION.find(([re]) => re.test(t))?.[1] || null;
}

function objetivoFormacion(maestro, cat) {
  const base = ciudadBase(maestro, cat);
  return (maestro.formacion || [])
    .filter((f) => f.mostrar_en_cv !== false)
    .map((f) => ({
      titulo: f.titulo_es,
      institucion: f.institucion,
      institucion_catalogo: elegir(cat.instituciones, [f.institucion]),
      nivel: nivelEducativo(f),
      nucleo: deElempleo(f, "nucleo_conocimiento") || null,
      estado_id: f.graduado ? "1" : "2",
      inicio: f.inicio,
      fin: f.fin,
      ciudad: elegirCiudad(cat.ciudades, f.ciudad) || base,
    }));
}

function objetivoCursos(maestro, cat) {
  const base = ciudadBase(maestro, cat);
  return (maestro.certificaciones || []).map((c) => ({
    nombre: c.nombre,
    institucion: c.emisor,
    fecha: c.fecha,
    area: (deElempleo(c, "area") && elegir(cat.areas_cursos, [deElempleo(c, "area")])) || (deElempleo(maestro, "area_cursos") && elegir(cat.areas_cursos, [deElempleo(maestro, "area_cursos")])) || masParecido(cat.areas_cursos, [c.nombre]),
    ciudad: elegirCiudad(cat.ciudades, c.ciudad) || base,
  }));
}

/** Profesión del catálogo: perfil maestro "profesion" o el título más alto de la formación. */
function profesionObjetivo(maestro, cat) {
  const titulos = [maestro.profesion, ...(maestro.formacion || []).filter((f) => f.mostrar_en_cv !== false).map((f) => f.titulo_es)].filter(Boolean);
  return elegir(cat.profesiones, titulos) || masParecido(cat.profesiones, titulos);
}

/** Opción salarial cuyo rango contiene el salario mínimo laboral del perfil maestro. */
function salarioObjetivo(maestro, html) {
  const minimo = maestro.preferencias?.salario_minimo_laboral_cop;
  if (!minimo || !html) return null;
  const opciones = opcionesDeSelect(html, null, "Salaries.SelectedIds");
  const m = minimo / 1e6;
  return opciones.find((o) => {
    const r = rangoSalario(o.name);
    return r && m >= r[0] && (r[1] === null || m < r[1]);
  }) || null;
}

const NIVELES_IDIOMA = { basico: "1", intermedio: "2", avanzado: "3" };

/** Idiomas no nativos del perfil maestro con nivel Básico, Intermedio o Avanzado. */
function idiomasObjetivo(maestro) {
  return (maestro.idiomas || [])
    .filter((i) => i.idioma && !/nativ|materna/i.test(i.nivel || ""))
    .map((i) => {
      const n = normalizar(i.nivel);
      const nivel = /avanz|fluid|bilingue|c1|c2/.test(n) ? "Avanzado" : /intermed|b1|b2/.test(n) ? "Intermedio" : "Básico";
      return { idioma: i.idioma, nivel, nivel_id: NIVELES_IDIOMA[normalizar(nivel)] };
    });
}

/** Redes que elempleo acepta y cuya URL aparece en datos_personales (se reconoce por el dominio). */
function redesObjetivo(maestro, redesGet) {
  const urls = Object.values(maestro.datos_personales || {}).filter((v) => typeof v === "string" && /^https?:\/\//i.test(v));
  const salida = [];
  for (const red of redesGet.socialNetworksInfo || []) {
    const url = urls.find((u) => u.toLowerCase().includes(String(red.regularExpresion).toLowerCase()));
    if (url) salida.push({ id: red.id, red: red.value, url });
  }
  return salida;
}

/** País de residencia y, solo si acepta reubicarse, los demás países de sus preferencias. */
function paisesObjetivo(maestro, cat) {
  const pref = maestro.preferencias || {};
  const nombres = [maestro.datos_personales?.pais, ...(pref.acepta_reubicacion ? pref.paises || [] : [])].filter(Boolean);
  const paises = [];
  for (const n of nombres) {
    const p = cat.paises.find((c) => normalizar(c.name) === normalizar(n));
    if (p && !paises.some((x) => x.id === p.id)) paises.push(p);
  }
  return paises;
}

/* ---------------------------------------------------------------- comparar */

export async function compararPerfil() {
  const maestro = cargarPerfilMaestro();
  const html = await paginaHojaDeVida();
  const actual = await verMiPerfil();
  const cat = await catalogos({ html });
  const diferencias = [];
  const agregar = (seccion, tipo, detalle) => diferencias.push({ seccion, tipo, detalle });

  // Perfil profesional
  const pp = actual.perfil_profesional;
  if (normalizar(pp.texto) !== normalizar(maestro.resumen?.es)) agregar("perfil_profesional", "desactualizado", "El texto del perfil no coincide con el resumen del perfil maestro.");
  const anios = aniosTotales(maestro);
  if (anios && String(pp.anios_experiencia) !== String(anios)) agregar("perfil_profesional", "desactualizado", `Años de experiencia: ${pp.anios_experiencia} → ${anios}.`);
  const salario = salarioObjetivo(maestro, html);
  if (salario && normalizar(pp.aspiracion_salarial) !== normalizar(salario.name)) agregar("perfil_profesional", "desactualizado", `Aspiración salarial: ${pp.aspiracion_salarial} → ${salario.name}.`);
  const profesion = profesionObjetivo(maestro, cat);
  if (profesion && normalizar(pp.profesion) !== normalizar(profesion.name)) agregar("perfil_profesional", "desactualizado", `Profesión: "${pp.profesion}" → "${profesion.name}".`);

  // Experiencia
  const objExp = objetivoExperiencia(maestro, cat);
  for (const o of objExp) {
    const existe = actual.experiencia.find((x) => mismaEmpresa(x.empresa, o.claves));
    if (!existe) agregar("experiencia", "falta", `${o.cargo} en ${o.empresa} (${o.inicio} – ${o.fin || "actual"}).`);
    else if (normalizar(existe.cargo) !== normalizar(o.cargo)) agregar("experiencia", "desactualizado", `${existe.empresa}: cargo "${existe.cargo}" → "${o.cargo}".`);
  }
  for (const x of actual.experiencia) {
    if (!objExp.some((o) => mismaEmpresa(x.empresa, o.claves))) agregar("experiencia", "sobra", `${x.cargo} en ${x.empresa} (id ${x.id}) no está en el perfil maestro.`);
  }

  // Formación
  for (const o of objetivoFormacion(maestro, cat)) {
    if (!actual.formacion.some((x) => mismoEstudio(x.titulo, o.titulo))) {
      agregar("formacion", "falta", `${o.titulo} — ${o.institucion} (${o.inicio} – ${o.fin}).`);
    }
  }
  const ocultos = (maestro.formacion || []).filter((f) => f.mostrar_en_cv === false).map((f) => normalizar(f.titulo_es).split(" ").slice(-2).join(" "));
  for (const x of actual.formacion) {
    if (ocultos.some((o) => normalizar(x.titulo).includes(o))) agregar("formacion", "sobra", `${x.titulo} (id ${x.id}) está marcado para no mostrarse en el CV.`);
  }

  // Cursos
  for (const o of objetivoCursos(maestro, cat)) {
    if (!actual.cursos.some((x) => normalizar(x.nombre) === normalizar(o.nombre))) agregar("cursos", "falta", `${o.nombre} — ${o.institucion} (${o.fecha}).`);
  }
  for (const x of actual.cursos) {
    if (!(maestro.certificaciones || []).some((c) => normalizar(c.nombre) === normalizar(x.nombre))) agregar("cursos", "sobra", `${x.nombre} (id ${x.id}) no está en el perfil maestro.`);
  }

  // Idiomas
  for (const i of idiomasObjetivo(maestro)) {
    const existe = actual.idiomas.find((x) => normalizar(x.idioma) === normalizar(i.idioma));
    if (!existe) agregar("idiomas", "falta", `${i.idioma} ${i.nivel}.`);
    else if (normalizar(existe.nivel) !== normalizar(i.nivel)) agregar("idiomas", "desactualizado", `${i.idioma}: ${existe.nivel} → ${i.nivel}.`);
  }

  // Redes
  const redes = await pedirJson("/co/Persons/SocialNetwork/Get");
  for (const r of redesObjetivo(maestro, redes)) {
    if (!actual.redes_sociales.some((x) => x.id === r.id)) agregar("redes_sociales", "falta", `${r.red}: ${r.url}.`);
  }

  // Habilidades
  const hk = maestro.habilidades_clave || {};
  const deseadas = [...(hk.tecnicas || []), ...(hk.blandas || [])].slice(0, MAX_HABILIDADES);
  const faltanHab = deseadas.filter((h) => !actual.habilidades.some((a) => normalizar(a) === normalizar(h)));
  if (faltanHab.length) agregar("habilidades", actual.habilidades.length ? "desactualizado" : "falta", `Faltan: ${faltanHab.join(", ")}.`);

  // Archivos
  const cvs = actual.archivos.filter((a) => /\.pdf$/i.test(a.nombre));
  if (!cvs.length) agregar("archivos", "falta", "No hay CV en PDF adjunto.");
  else if (cvs.every((a) => /\/20(1\d|2[0-3])\//.test(a.url || ""))) agregar("archivos", "desactualizado", `El CV adjunto es antiguo (${cvs.map((a) => a.nombre).join(", ")}). Usa subir-cv.`);

  return {
    resumen: `${diferencias.length} diferencias entre elempleo y el perfil maestro.`,
    diferencias,
    siguiente_paso: "Usa actualizar-perfil por sección (sin aplicar) para ver el cambio exacto antes de confirmarlo.",
  };
}

/* ---------------------------------------------------------------- actualizar */

function respaldar(nombre, datos) {
  fs.mkdirSync(CARPETA_RESPALDOS, { recursive: true });
  const archivo = path.join(CARPETA_RESPALDOS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${nombre}.json`);
  fs.writeFileSync(archivo, JSON.stringify(datos, null, 2));
  return archivo;
}

async function guardar(html, accion, campos) {
  const token = tokenDeFormulario(html, accion);
  if (!token) throw new Error(`No encontré el formulario ${accion} en la hoja de vida.`);
  const cuerpo = campos instanceof URLSearchParams ? campos : paramEstiloJquery(campos);
  cuerpo.set("__RequestVerificationToken", token);
  const r = await pedirJson(accion, { metodo: "POST", cuerpo });
  if (r && (r.isModelValid === false || r.error)) throw new Error(r.errorMessage || r.message || `elempleo rechazó ${accion}.`);
  return r;
}

async function borrar(html, accionForm, accionBorrar, id, claveId = "id") {
  const token = tokenDeFormulario(html, accionForm);
  return pedirJson(accionBorrar, { metodo: "POST", cuerpo: { [claveId]: String(id), __RequestVerificationToken: token } });
}

const SECCIONES = ["perfil_profesional", "experiencia", "formacion", "cursos", "idiomas", "redes_sociales", "habilidades", "seguridad_social"];

const MAX_HABILIDADES = 20;

/** Opciones { id, name } de un <select name="..."> dentro del formulario con esa acción (o en toda la página si accion es null). */
function opcionesDeSelect(html, accion, nombre) {
  let form = html;
  if (accion) {
    const i = html.indexOf(`action="${accion}"`);
    if (i === -1) return [];
    form = html.slice(i, html.indexOf("</form>", i));
  }
  const sel = form.match(new RegExp(`<select[^>]*name="${nombre.replace(/\./g, "\\.")}"[^>]*>([\\s\\S]*?)</select>`));
  if (!sel) return [];
  return [...sel[1].matchAll(/value="(-?\d+)"[^>]*>([^<]*)/g)].filter((m) => m[1] !== "-1").map((m) => ({ id: m[1], name: decodificarHtml(m[2]).trim() }));
}

// El catálogo de elempleo conserva nombres antiguos de algunas entidades.
const ALIAS_SEGURIDAD_SOCIAL = {
  colpensiones: "ISS",
  "seguro social": "ISS",
  "seguros sociales": "ISS",
  "old mutual": "SKANDIA",
  "skandia old mutual": "SKANDIA",
  "bbva": "BBVA HORIZONTE",
  "horizonte": "BBVA HORIZONTE",
  "fna": "FONDO NACIONAL DEL AHORRO",
  "eps sos": "SERVICIO OCCIDENTAL DE SALUD",
  "sos": "SERVICIO OCCIDENTAL DE SALUD",
};

const CAMPOS_SEGURIDAD_SOCIAL = [
  ["pension_obligatoria", "MandatoryPensionFunds.SelectedIds", "Fondo de pensión obligatoria"],
  ["cesantias", "UnemploymentFunds.SelectedIds", "Fondo de cesantías"],
  ["eps", "HealthPromoterEntities.SelectedIds", "EPS"],
  ["caja_compensacion", "FamilyCompensationFunds.SelectedIds", "Caja de compensación"],
];

/**
 * Sin aplicar: devuelve el plan (antes → después). Con aplicar=true: respalda y ejecuta.
 * eliminar_ids: ids de entradas sobrantes que el usuario confirmó borrar.
 */
export async function actualizarPerfil({ seccion, aplicar = false, eliminar_ids = [] }) {
  if (!SECCIONES.includes(seccion)) return { estado: "error", mensaje: `Sección no válida. Usa: ${SECCIONES.join(", ")}.` };
  const maestro = cargarPerfilMaestro();
  const html = await paginaHojaDeVida();
  const cat = await catalogos({ html });
  const actual = await verMiPerfil();
  const plan = [];

  if (seccion === "perfil_profesional") {
    const crudo = (await pedirJson("/co/Persons/ProfessionalProfile/Get")).result || {};
    const pref = maestro.preferencias || {};
    const anios = aniosTotales(maestro) ?? crudo.experienceYears?.selectedIds?.[0];
    const profesion = profesionObjetivo(maestro, cat);
    const salario = salarioObjetivo(maestro, html);
    const paises = paisesObjetivo(maestro, cat);
    const despues = {
      profesion: profesion?.name ?? actual.perfil_profesional.profesion,
      texto: maestro.resumen?.es || actual.perfil_profesional.texto,
      anios_experiencia: anios,
      aspiracion_salarial: salario?.name ?? actual.perfil_profesional.aspiracion_salarial,
      puede_mudarse: pref.acepta_reubicacion ?? actual.perfil_profesional.puede_mudarse,
      puede_viajar: pref.puede_viajar ?? actual.perfil_profesional.puede_viajar,
      paises: paises.length ? paises.map((p) => p.name) : actual.perfil_profesional.paises,
    };
    const requiere = [`Años de experiencia total: ${anios} (desde el primer empleo del perfil maestro).`];
    if (!profesion) requiere.push('No encontré tu profesión en el catálogo de elempleo; agrega "profesion" al perfil maestro con el nombre exacto.');
    plan.push({ accion: "actualizar", antes: actual.perfil_profesional, despues, requiere_confirmar: requiere });
    if (aplicar) {
      const respaldo = respaldar("perfil_profesional", actual.perfil_profesional);
      await guardar(html, "/co/Persons/ProfessionalProfile/Save", {
        ProfessionId: String(profesion?.id ?? crudo.professionId),
        VieneDeIA: "False",
        Profile: despues.texto,
        "ExperienceYears.SelectedIds": String(Math.min(Number(anios) || 0, 36)),
        "Salaries.SelectedIds": String(salario?.id ?? crudo.salaries?.selectedIds?.[0] ?? ""),
        CanMove: String(Boolean(despues.puede_mudarse)),
        CanTravel: String(Boolean(despues.puede_viajar)),
        workCountries: paises.length ? paises.map((p) => ({ id: p.id, name: p.name, normalizedName: p.name })) : crudo.workCountries || [],
      });
      return { estado: "actualizado", seccion, respaldo, plan };
    }
  }

  if (seccion === "experiencia") {
    const objetivo = objetivoExperiencia(maestro, cat);
    for (const o of objetivo) {
      const existe = actual.experiencia.find((x) => mismaEmpresa(x.empresa, o.claves));
      plan.push({
        accion: existe ? "actualizar" : "agregar",
        id: existe?.id ?? 0,
        antes: existe ? { cargo: existe.cargo, empresa: existe.empresa, inicio: existe.inicio, fin: existe.fin } : null,
        despues: {
          cargo: o.cargo,
          empresa: o.empresa,
          cargo_equivalente: o.cargo_equivalente?.name,
          sector: o.sector?.name,
          ciudad: o.ciudad?.name,
          inicio: o.inicio,
          fin: o.fin || "actual",
          logros: o.logros,
        },
      });
    }
    for (const x of actual.experiencia) {
      if (!objetivo.some((o) => mismaEmpresa(x.empresa, o.claves))) {
        plan.push({ accion: eliminar_ids.includes(x.id) ? "eliminar" : "sobra (no se borra sin confirmar)", id: x.id, antes: { cargo: x.cargo, empresa: x.empresa, inicio: x.inicio } });
      }
    }
    if (aplicar) {
      const respaldo = respaldar("experiencia", actual.experiencia);
      const hechos = [];
      for (const paso of plan.filter((p) => p.accion === "agregar" || p.accion === "actualizar")) {
        const o = objetivo.find((x) => x.empresa === paso.despues.empresa);
        if (!o.cargo_equivalente || !o.sector || !o.ciudad) throw new Error(`Falta cargo equivalente, sector o ciudad para ${o.empresa} en los catálogos.`);
        await guardar(html, "/co/Persons/LaboralExperience/Save", {
          Id: String(paso.id),
          VieneDeIA: "False",
          Position: o.cargo,
          "EquivalentPositionStructure.typehead": o.cargo_equivalente.name,
          EquivalentPositionStructure: String(o.cargo_equivalente.id),
          CompanyName: o.empresa,
          "CompanySector.typehead": o.sector.name,
          CompanySector: String(o.sector.id),
          "City.typehead": o.ciudad.name,
          City: String(o.ciudad.id),
          StartDate: ddmmyyyy(o.inicio),
          IsCurrentlyWorking: String(!o.fin),
          EndDate: o.fin ? ddmmyyyy(o.fin) : "",
          Achievements: o.logros,
        });
        hechos.push(`${paso.accion}: ${o.cargo} en ${o.empresa}`);
      }
      for (const paso of plan.filter((p) => p.accion === "eliminar")) {
        await borrar(html, "/co/Persons/LaboralExperience/Save", "/co/Persons/LaboralExperience/Delete", paso.id, "Id");
        hechos.push(`eliminada: ${paso.antes.cargo} en ${paso.antes.empresa}`);
      }
      return { estado: "actualizado", seccion, respaldo, hechos };
    }
  }

  if (seccion === "formacion") {
    const objetivo = objetivoFormacion(maestro, cat);
    for (const o of objetivo) {
      const existe = actual.formacion.find((x) => mismoEstudio(x.titulo, o.titulo));
      if (!existe) {
        plan.push({
          accion: "agregar",
          despues: {
            titulo: o.titulo,
            nivel: o.nivel,
            institucion: o.institucion_catalogo?.name || `${o.institucion} (como "otra institución")`,
            estado: o.estado_id === "1" ? "Culminado" : "En curso",
            inicio: o.inicio,
            fin: o.fin,
            ciudad: o.ciudad?.name,
          },
        });
      }
    }
    for (const x of actual.formacion) {
      if (eliminar_ids.includes(x.id)) plan.push({ accion: "eliminar", id: x.id, antes: { titulo: x.titulo } });
    }
    if (aplicar) {
      const respaldo = respaldar("formacion", actual.formacion);
      const niveles = opcionesDeSelect(html, "/co/Persons/FormalEducation/Save", "EducationLevels.SelectedId");
      const nucleos = actual.formacion.length
        ? ((await pedirJson(`/co/Persons/FormalEducation/Get?id=${actual.formacion[0].id}`)).result?.basicKnowledgeCores?.sourceList || []).map((n) => ({ id: n.value, name: n.text }))
        : [];
      const hechos = [];
      for (const paso of plan.filter((p) => p.accion === "agregar")) {
        const o = objetivo.find((x) => x.titulo === paso.despues.titulo);
        const nivel = o.nivel && elegir(niveles, [o.nivel]);
        if (!nivel) throw new Error(`No sé el nivel educativo de "${o.titulo}". Agrega "nivel" en esa formación del perfil maestro (${niveles.map((n) => n.name).join(", ")}).`);
        const nucleo = (o.nucleo && elegir(nucleos, [o.nucleo])) || masParecido(nucleos, [o.titulo]);
        const campos = {
          VieneDeIA: "False",
          Id: "0",
          "EducationLevels.SelectedId": nivel.id,
          "BasicKnowledgeCores.SelectedId": String(nucleo?.id ?? ""),
          "EducationStatus.SelectedIds": o.estado_id,
          StartDate: ddmmyyyy(o.inicio),
          EndDate: o.fin ? ddmmyyyy(o.fin) : "",
          Degree: o.titulo,
          "City.typehead": o.ciudad?.name || "",
          City: String(o.ciudad?.id ?? ""),
        };
        if (o.institucion_catalogo) {
          campos["InstituteId.typehead"] = o.institucion_catalogo.name;
          campos.InstituteId = String(o.institucion_catalogo.id);
        } else {
          campos["InstituteId.typehead"] = "Otra";
          campos.InstituteId = "-3";
          campos.OtherInstitute = o.institucion;
        }
        await guardar(html, "/co/Persons/FormalEducation/Save", campos);
        hechos.push(`agregada: ${o.titulo}`);
      }
      for (const paso of plan.filter((p) => p.accion === "eliminar")) {
        await borrar(html, "/co/Persons/FormalEducation/Save", "/co/Persons/FormalEducation/Delete", paso.id, "id");
        hechos.push(`eliminada: ${paso.antes.titulo}`);
      }
      return { estado: "actualizado", seccion, respaldo, hechos };
    }
  }

  if (seccion === "cursos") {
    const objetivo = objetivoCursos(maestro, cat);
    for (const o of objetivo) {
      if (!actual.cursos.some((x) => normalizar(x.nombre) === normalizar(o.nombre))) {
        plan.push({ accion: "agregar", despues: { nombre: o.nombre, institucion: o.institucion, tipo: "Curso", area: o.area?.name, fecha: o.fecha } });
      }
    }
    for (const x of actual.cursos) {
      if (eliminar_ids.includes(x.id)) plan.push({ accion: "eliminar", id: x.id, antes: { nombre: x.nombre } });
    }
    if (aplicar) {
      const respaldo = respaldar("cursos", actual.cursos);
      const hechos = [];
      for (const paso of plan.filter((p) => p.accion === "agregar")) {
        const o = objetivo.find((x) => x.nombre === paso.despues.nombre);
        await guardar(html, "/co/Persons/NonFormalEducation/Save", {
          VieneDeIA: "False",
          Id: "0",
          "NonFormalEducationType.SelectedIds": "3",
          Name: o.nombre,
          Institute: o.institucion,
          "AreaId.typehead": o.area?.name || "",
          AreaId: String(o.area?.id ?? ""),
          "CourseLoad.SelectedIds": "1",
          StartDate: ddmmyyyy(o.fecha),
          IsNotFinished: "false",
          EndDate: ddmmyyyy(o.fecha),
          "City.typehead": o.ciudad?.name || "",
          City: String(o.ciudad?.id ?? ""),
          EducationDescription: "",
        });
        hechos.push(`agregado: ${o.nombre}`);
      }
      for (const paso of plan.filter((p) => p.accion === "eliminar")) {
        await borrar(html, "/co/Persons/NonFormalEducation/Save", "/co/Persons/NonFormalEducation/Delete", paso.id, "id");
        hechos.push(`eliminado: ${paso.antes.nombre}`);
      }
      return { estado: "actualizado", seccion, respaldo, hechos };
    }
  }

  if (seccion === "idiomas") {
    const disponibles = ((await pedirJson("/co/Persons/LanguageKnowledge/GetAvaibleLanguages")).selectListItems || [])
      .filter((x) => x.value !== "-1")
      .map((x) => ({ id: x.value, name: x.text }));
    for (const i of idiomasObjetivo(maestro)) {
      const existe = actual.idiomas.find((x) => normalizar(x.idioma) === normalizar(i.idioma));
      if (existe && normalizar(existe.nivel) === normalizar(i.nivel)) continue;
      const idiomaId = existe?.idioma_id ?? elegir(disponibles, [i.idioma])?.id;
      if (!idiomaId) {
        plan.push({ accion: "no_disponible", despues: i, nota: `elempleo no ofrece "${i.idioma}" en su lista.` });
        continue;
      }
      plan.push({ accion: existe ? "actualizar" : "agregar", id: existe?.id ?? 0, idioma_id: idiomaId, antes: existe ? { idioma: existe.idioma, nivel: existe.nivel } : null, despues: { idioma: i.idioma, nivel: i.nivel }, nivel_id: i.nivel_id });
    }
    const cambios = plan.filter((p) => p.accion === "agregar" || p.accion === "actualizar");
    if (aplicar && cambios.length) {
      const respaldo = respaldar("idiomas", actual.idiomas);
      for (const p of cambios) {
        await guardar(html, "/co/Persons/LanguageKnowledge/Save", {
          Id: String(p.id),
          VieneDeIA: "False",
          "Languages.SelectedIds": String(p.idioma_id),
          "WrittenLevel.SelectedId": p.nivel_id,
          "SpokenLevel.SelectedId": p.nivel_id,
          "ReadLevel.SelectedId": p.nivel_id,
          "ListeningLevel.SelectedId": p.nivel_id,
        });
      }
      return { estado: "actualizado", seccion, respaldo, plan };
    }
  }

  if (seccion === "redes_sociales") {
    const redes = await pedirJson("/co/Persons/SocialNetwork/Get");
    const nuevas = redesObjetivo(maestro, redes).filter((r) => !actual.redes_sociales.some((x) => x.id === r.id));
    for (const r of nuevas) plan.push({ accion: "agregar", despues: { red: r.red, url: r.url } });
    if (aplicar && plan.length) {
      const respaldo = respaldar("redes_sociales", actual.redes_sociales);
      const modelo = actual.redes_sociales.map((r) => ({ Id: r.id, Url: r.url }));
      for (const r of nuevas) modelo.push({ Id: r.id, Url: encodeURI(decodeURI(r.url)) });
      await guardar(html, "/co/Persons/SocialNetwork/Save", { model: modelo });
      return { estado: "actualizado", seccion, respaldo, plan };
    }
  }

  if (seccion === "habilidades") {
    const hk = maestro.habilidades_clave || {};
    const deseadas = [...(hk.tecnicas || []), ...(hk.blandas || [])].slice(0, MAX_HABILIDADES);
    if (!deseadas.length) return { estado: "error", mensaje: "El perfil maestro no tiene habilidades_clave." };
    const largas = deseadas.filter((h) => h.length > 40);
    if (largas.length) return { estado: "error", mensaje: `Estas habilidades pasan de 40 caracteres: ${largas.join(", ")}.` };
    const catalogo = cat.habilidades.map((h) => ({ id: h.id, name: decodificarHtml(h.name) }));
    const objetivo = deseadas.map((nombre) => catalogo.find((c) => normalizar(c.name) === normalizar(nombre)) || { id: 0, name: nombre });
    const iguales = actual.habilidades.length === objetivo.length && objetivo.every((o) => actual.habilidades.some((a) => normalizar(a) === normalizar(o.name)));
    if (!iguales) {
      plan.push({
        accion: actual.habilidades.length ? "reemplazar" : "agregar",
        antes: actual.habilidades,
        despues: objetivo.map((o) => `${o.name}${o.id ? "" : " (texto libre)"}`),
      });
    }
    if (aplicar && plan.length) {
      const respaldo = respaldar("habilidades", actual.habilidades);
      await guardar(html, "/co/Persons/Skills/Save", { Skills: objetivo, NewSkill: "", MaxSkillAllowed: "0" });
      return { estado: "actualizado", seccion, respaldo, plan };
    }
  }

  if (seccion === "seguridad_social") {
    const ss = maestro.seguridad_social;
    if (!ss) return { estado: "error", mensaje: "El perfil maestro no tiene seguridad_social. Pregúntale al usuario sus entidades; no las supongas." };
    const actualSs = (await pedirJson("/co/Persons/SocialSecurity/Get")).result || {};
    const accion = "/co/Persons/SocialSecurity/Save";
    const campos = { OtherOptionId: "-1", ContributeToVoluntaryPensionFund: ss.pension_voluntaria ? "true" : "false" };
    const despues = {};
    const faltan = [];
    const pares = [...CAMPOS_SEGURIDAD_SOCIAL];
    if (ss.pension_voluntaria) pares.push(["pension_voluntaria", "VolunteersPensionFunds.SelectedIds", "Fondo de pensiones voluntarias"]);
    for (const [clave, nombre, etiqueta] of pares) {
      const valor = ss[clave];
      const opciones = opcionesDeSelect(html, accion, nombre);
      const opcion = valor ? elegir(opciones, [ALIAS_SEGURIDAD_SOCIAL[normalizar(valor)] || valor, valor]) : null;
      if (!opcion) {
        const comodines = opciones.filter((o) => /^(otra|ninguna|sin definir)$/i.test(o.name)).map((o) => `"${o.name}"`);
        faltan.push(
          `${etiqueta}: "${valor ?? "(vacío)"}" no está en la lista de elempleo.` +
            (comodines.length ? ` Pregúntale al usuario si prefiere ${comodines.join(", ")} y guárdalo así en el perfil maestro.` : "")
        );
        continue;
      }
      campos[nombre] = opcion.id;
      despues[etiqueta] = opcion.name;
    }
    if (faltan.length) return { estado: "requiere_revision", seccion, mensaje: faltan.join(" ") };
    const antes = {
      "Fondo de pensión obligatoria": actualSs.mandatoryPensionFund,
      "Fondo de cesantías": actualSs.unemploymentFund,
      EPS: actualSs.healthPromoterEntityId,
      "Caja de compensación": actualSs.familyCompensationFundId,
    };
    const yaIgual = CAMPOS_SEGURIDAD_SOCIAL.every(([, nombre]) => {
      const clave = nombre.split(".")[0].replace(/^./, (c) => c.toLowerCase());
      return String(actualSs[clave]?.selectedIds?.[0] ?? "-1") === campos[nombre];
    });
    if (!yaIgual) plan.push({ accion: "actualizar", antes, despues });
    if (aplicar && plan.length) {
      const respaldo = respaldar("seguridad_social", actualSs);
      await guardar(html, accion, campos);
      return { estado: "actualizado", seccion, respaldo, plan };
    }
  }

  return {
    estado: plan.length ? "plan" : "sin_cambios",
    seccion,
    plan,
    instrucciones: plan.length
      ? "Muestra este plan al usuario. Si lo aprueba, repite con aplicar: true (y eliminar_ids con los ids que confirme borrar)."
      : "Esta sección ya coincide con el perfil maestro.",
  };
}

/* ---------------------------------------------------------------- foto y CV */

export async function subirFoto({ aplicar = false } = {}) {
  const maestro = cargarPerfilMaestro();
  const relativa = maestro.datos_personales?.foto;
  if (!relativa) return { estado: "error", mensaje: "El perfil maestro no tiene foto." };
  const ruta = resolverArchivo(relativa);
  if (!fs.existsSync(ruta)) return { estado: "error", mensaje: `No encontré la foto en ${ruta}.` };
  const extension = path.extname(ruta).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".gif"].includes(extension)) return { estado: "error", mensaje: "elempleo solo acepta fotos JPG, PNG o GIF." };
  const bytes = fs.readFileSync(ruta);
  if (bytes.length > 3 * 1024 * 1024) return { estado: "error", mensaje: "La foto pesa más de 3 MB." };
  if (!aplicar) return { estado: "plan", accion: "subir foto de perfil", archivo: ruta, tamano_kb: Math.round(bytes.length / 1024), instrucciones: "Repite con aplicar: true para subirla." };

  const html = await paginaHojaDeVida();
  const token = tokenDeFormulario(html, "/co/Persons/PersonalInformation/LoadSyncPhoto");
  const form = new FormData();
  form.set("__RequestVerificationToken", token);
  const tipo = extension === ".png" ? "image/png" : extension === ".gif" ? "image/gif" : "image/jpeg";
  form.set("Image", new Blob([bytes], { type: tipo }), `photo${extension}`);
  const r = await pedirJson("/co/Persons/PersonalInformation/LoadAsyncPhoto", { metodo: "POST", tipo: "multipart", cuerpo: form });
  if (!r || r.success !== true) return { estado: "error", mensaje: r?.message || "elempleo no aceptó la foto." };
  return { estado: "actualizado", mensaje: "Foto de perfil actualizada." };
}

/** cv_pdf puede ser una ruta o un objeto { version: ruta }; sin versión se usa la primera. */
export async function subirCv({ version, aplicar = false, reemplazar_id } = {}) {
  const maestro = cargarPerfilMaestro();
  const cv = maestro.cv_pdf;
  const versiones = cv && typeof cv === "object" ? Object.keys(cv) : [];
  if (version && !versiones.includes(version)) return { estado: "error", mensaje: `El perfil maestro no tiene cv_pdf.${version}. Versiones: ${versiones.join(", ") || "ninguna"}.` };
  const relativa = typeof cv === "string" ? cv : cv?.[version || versiones[0]];
  if (!relativa) return { estado: "error", mensaje: "El perfil maestro no tiene cv_pdf." };
  const ruta = resolverArchivo(relativa);
  if (!fs.existsSync(ruta)) return { estado: "error", mensaje: `No encontré el PDF en ${ruta}.` };
  const bytes = fs.readFileSync(ruta);
  const actuales = await listarMisCv();
  const reemplazo = reemplazar_id ? actuales.archivos.find((a) => a.id === Number(reemplazar_id)) : null;
  if (bytes.length > (actuales.megas_por_archivo || 3) * 1024 * 1024) return { estado: "error", mensaje: `El PDF pesa más de ${actuales.megas_por_archivo || 3} MB.` };
  if (!reemplazo && actuales.archivos.length >= (actuales.maximo || 5)) return { estado: "requiere_revision", mensaje: "Ya tienes el máximo de archivos. Indica reemplazar_id." };

  if (!aplicar) {
    return {
      estado: "plan",
      accion: reemplazo ? `reemplazar "${reemplazo.nombre}" por "${path.basename(ruta)}"` : `subir "${path.basename(ruta)}"`,
      tamano_kb: Math.round(bytes.length / 1024),
      archivos_actuales: actuales.archivos,
      instrucciones: "Repite con aplicar: true para subirlo.",
    };
  }

  const html = await paginaHojaDeVida();
  const token = tokenDeFormulario(html, "/co/Persons/Attachment/LoadFile");
  const form = new FormData();
  form.set("__RequestVerificationToken", token);
  form.set("File", new Blob([bytes], { type: "application/pdf" }), path.basename(ruta));
  await pedirJson("/co/Persons/Attachment/SaveAttachment", { metodo: "POST", tipo: "multipart", cuerpo: form });
  if (reemplazo) await borrar(html, "/co/Persons/Attachment/LoadFile", "/co/Persons/Attachment/Delete", reemplazo.id, "id");
  return { estado: "actualizado", ...(await listarMisCv()) };
}

/* ---------------------------------------------------------------- perfil maestro inicial */

/** Borrador de perfil maestro (estándar v1) con la hoja de vida de elempleo. No guarda nada. */
export async function borradorDesdeElempleo() {
  const html = await paginaHojaDeVida();
  const actual = await verMiPerfil();
  const niveles = opcionesDeSelect(html, "/co/Persons/FormalEducation/Save", "EducationLevels.SelectedId");
  const pp = actual.perfil_profesional;
  return {
    version: 1,
    actualizado: new Date().toISOString().slice(0, 10),
    fuentes: ["elempleo.com"],
    datos_personales: { nombre: "", ciudad: "", pais: pp.paises?.[0] || "", zona_horaria: "", telefono: "", correo: "", linkedin: "", github: "", portafolio: "" },
    titular: { es: "" },
    resumen: { es: pp.texto || "" },
    profesion: pp.profesion || "",
    experiencia: actual.experiencia.map((e) => {
      const lineas = String(e.logros || "").split(/\n+/).map((l) => l.replace(/^[•\-*]\s*/, "").trim()).filter(Boolean);
      const linea = lineas.find((l) => /^(tecnolog[ií]as|stack|herramientas)\s*:/i.test(l));
      return {
        empresa: e.empresa,
        cargo: e.cargo,
        inicio: e.inicio,
        fin: e.actual ? null : e.fin,
        ubicacion: e.ciudad || "",
        logros_es: lineas.filter((l) => l !== linea),
        tecnologias: linea ? linea.replace(/^[^:]*:\s*/, "").split(/\s*,\s*/).filter(Boolean) : [],
        portales: { [PORTAL]: { cargo_equivalente: e.cargo_equivalente, sector: e.sector, ciudad: e.ciudad } },
      };
    }),
    formacion: actual.formacion.map((f) => ({
      institucion: f.institucion,
      titulo_es: f.titulo,
      nivel: niveles.find((n) => String(n.id) === String(f.nivel_id))?.name || "",
      inicio: f.inicio,
      fin: f.fin,
      graduado: String(f.estado_id) === "1",
    })),
    certificaciones: actual.cursos.map((c) => ({ nombre: c.nombre, emisor: c.institucion, fecha: c.fin || c.inicio })),
    aptitudes: {},
    habilidades_clave: { tecnicas: [], blandas: actual.habilidades },
    idiomas: actual.idiomas.map((i) => ({ idioma: i.idioma, nivel: i.nivel })),
    preferencias: {
      modalidad: "",
      acepta_reubicacion: Boolean(pp.puede_mudarse),
      puede_viajar: Boolean(pp.puede_viajar),
      paises: pp.paises || [],
      salario_minimo_laboral_cop: rangoSalario(pp.aspiracion_salarial)?.[0] * 1e6 || null,
      salario_minimo_prestacion_cop: null,
    },
    respuestas_frecuentes: {},
    pendientes_de_confirmar: [
      "Completa datos_personales: nombre, ciudad, país y enlaces (la foto y el CV se pasan a guardar-perfil-maestro).",
      "Escribe el titular y revisa el resumen.",
      "Agrega las tecnologías de cada experiencia y tus aptitudes: evaluar-encaje las usa para saber qué ofertas te encajan.",
      "Define modalidad y salario mínimo en preferencias.",
    ],
  };
}

export { decodificarHtml };

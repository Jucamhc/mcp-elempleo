import { cargarPerfilMaestro } from "./perfil-maestro.js";
import { detalleDeOferta, rangoSalario } from "./ofertas.js";

const normalizar = (t) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Catálogo genérico de tecnologías y sus variantes en las ofertas. Las que aparecen en el perfil
// maestro cuentan como propias; el resto, como ajenas.
const TECNOLOGIAS = {
  React: /\breact(\.?js)?\b(?!\s*native)/,
  "React Native": /react\s*native/,
  "Vue.js": /\bvue(\.?js)?\b/,
  Angular: /\bangular\b(?!\s*js)/,
  AngularJS: /angular\s*js/,
  "Next.js": /\bnext\.?js\b/,
  Svelte: /\bsvelte\b/,
  TypeScript: /typescript|\bts\b/,
  JavaScript: /javascript|\bjs\b|es6/,
  "Node.js": /node(\.?js)?\b/,
  NestJS: /nest(\.?js)?\b/,
  Express: /\bexpress(\.?js)?\b/,
  PHP: /\bphp\b/,
  Laravel: /laravel/,
  Symfony: /symfony/,
  Yii: /\byii\b/,
  WordPress: /wordpress/,
  Expo: /\bexpo\b/,
  Java: /\bjava\b(?!\s*script)|spring/,
  ".NET / C#": /\.net|c#|csharp|asp\.net/,
  Python: /python|django|flask|fastapi/,
  Go: /\bgolang\b|\bgo\b(?=\s*(lang|developer|backend))/,
  "Flutter / Dart": /flutter|\bdart\b/,
  Kotlin: /kotlin/,
  Swift: /\bswift\b|ios nativo/,
  Ruby: /\bruby\b|rails/,
  Scala: /\bscala\b/,
  Rust: /\brust\b/,
  "C / C++": /\bc\+\+|\bc\b(?=\s*(y|and)\s*c\+\+)/,
  COBOL: /cobol|\bhost\b|mainframe|as\/?400/,
  "Salesforce / Apex": /salesforce|\bapex\b/,
  "SAP / ABAP": /\bsap\b|abap/,
  Solidity: /solidity|blockchain/,
  "Delphi / Visual Basic / Progress": /delphi|visual basic|\bprogress\b|\bvb6\b/,
  "Oracle Commerce": /oracle commerce|\bosf\b|\batg\b/,
  MySQL: /mysql/,
  PostgreSQL: /postgres/,
  "SQL Server": /sql server|t-?sql/,
  Oracle: /\boracle\b(?!\s*commerce)/,
  MongoDB: /mongo/,
  Redis: /\bredis\b/,
  "APIs REST": /\brest(ful)?\b|\bapis?\b/,
  GraphQL: /graphql/,
  Docker: /docker/,
  Kubernetes: /kubernetes|\bk8s\b/,
  AWS: /\baws\b|amazon web services/,
  Azure: /\bazure\b/,
  GCP: /\bgcp\b|google cloud/,
  Git: /\bgit\b|github|gitlab/,
  Linux: /linux/,
  "IA / LLM": /\bia\b|inteligencia artificial|\bllm|openai|claude|cursor|\bmcp\b/,
  Scrum: /scrum|agil/,
};

// Aparecen en casi cualquier oferta técnica: no definen el eje del cargo.
const GENERICAS = ["APIs REST", "Git", "Scrum", "JavaScript", "IA / LLM"];

const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Términos que el perfil maestro declara (aptitudes, tecnologías por experiencia y habilidades técnicas). */
function terminosDelPerfil(perfil) {
  const terminos = [
    ...Object.values(perfil.aptitudes || {}).flat(),
    ...(perfil.experiencia || []).flatMap((e) => e.tecnologias || []),
    ...(perfil.habilidades_clave?.tecnicas || []),
  ];
  return [...new Set(terminos.filter(Boolean).map(String))];
}

function clasificarTecnologias(perfil) {
  const terminos = terminosDelPerfil(perfil).map(normalizar);
  const propias = {};
  const ajenas = {};
  for (const [nombre, re] of Object.entries(TECNOLOGIAS)) {
    const declarada = terminos.some((t) => t === normalizar(nombre) || re.test(t));
    (declarada ? propias : ajenas)[nombre] = re;
  }
  // Términos cortos del perfil que el catálogo no conoce (p. ej. "Odoo", "Power BI").
  for (const t of terminos) {
    if (t.split(/\s+/).length > 2 || Object.values(propias).some((re) => re.test(t))) continue;
    propias[t] = new RegExp(`(^|[^a-z0-9])${escapar(t)}($|[^a-z0-9])`);
  }
  return { propias, ajenas };
}

const INGLES_ALTO = /bilingue|ingles (avanzado|fluido|c1|b2)|english (advanced|fluent)|\bb2\b|\bc1\b|\bc2\b|100% ingles|nivel avanzado de ingles/;
const NIVEL_INGLES_ALTO = /avanzado|nativo|bilingue|fluido|\bc1\b|\bc2\b/;

export async function evaluarEncaje(id) {
  const oferta = await detalleDeOferta(id);
  if (oferta.estado) return oferta;
  const perfil = cargarPerfilMaestro();
  const pref = perfil.preferencias || {};
  const titulo = normalizar(oferta.titulo);
  const texto = normalizar(`${oferta.titulo}\n${oferta.descripcion}`);

  const motivos = [];
  let veredicto = "encaja";
  const bajar = (a) => {
    if (a === "no_encaja" || (a === "encaja_parcial" && veredicto === "encaja")) veredicto = a;
  };

  // Modalidad
  const remoto = /remot/i.test(oferta.modalidad || "") || /\bremoto\b|100% remoto|teletrabajo/.test(titulo);
  if (/solo remoto/i.test(pref.modalidad || "") && !remoto) {
    bajar("no_encaja");
    motivos.push(`Modalidad ${oferta.modalidad || "no indicada"} en ${oferta.ciudad || "ciudad no indicada"}; solo buscas remoto.`);
  } else if (remoto && /presencial|asistir a (la )?oficina|vivir en|residir en|residencia en/.test(texto)) {
    bajar("encaja_parcial");
    motivos.push("Es remota, pero la descripción menciona presencialidad o residencia en una ciudad: confírmalo.");
  }

  // Salario según el tipo de contrato
  const prestacion = /prestaci/i.test(oferta.contrato || "");
  const minimoCop = prestacion ? pref.salario_minimo_prestacion_cop ?? pref.salario_minimo_laboral_cop : pref.salario_minimo_laboral_cop;
  if (minimoCop) {
    const minimo = minimoCop / 1e6;
    const tipo = prestacion ? "prestación de servicios" : "contrato laboral";
    const rango = rangoSalario(oferta.salario);
    if (!rango) {
      motivos.push(`Salario confidencial; tu mínimo para ${tipo} es $${minimo} millones.`);
      bajar("encaja_parcial");
    } else if (rango[1] !== null && rango[1] < minimo) {
      bajar("no_encaja");
      motivos.push(`Salario ${oferta.salario}, por debajo de tu mínimo de $${minimo} millones (${tipo}).`);
    } else if (rango[0] < minimo) {
      bajar("encaja_parcial");
      motivos.push(`Salario ${oferta.salario}: el rango toca tu mínimo de $${minimo} millones; negociable.`);
    }
  }

  // Stack (solo si el perfil declara tecnologías del catálogo)
  const { propias, ajenas } = clasificarTecnologias(perfil);
  const coincidencias = Object.entries(propias).filter(([, re]) => re.test(texto)).map(([n]) => n);
  const perfilTecnico = Object.keys(propias).some((n) => n in TECNOLOGIAS && !GENERICAS.includes(n));
  if (perfilTecnico) {
    const ajenasTitulo = Object.entries(ajenas).filter(([, re]) => re.test(titulo)).map(([n]) => n);
    const ajenasTexto = Object.entries(ajenas).filter(([, re]) => re.test(texto)).map(([n]) => n);
    const propiasTitulo = Object.entries(propias)
      .filter(([n, re]) => !GENERICAS.includes(n) && re.test(titulo))
      .map(([n]) => n);
    if (ajenasTitulo.length && !propiasTitulo.length) {
      bajar("no_encaja");
      motivos.push(`El cargo se centra en ${ajenasTitulo.join(", ")}, que no está en tu perfil.`);
    } else if (ajenasTitulo.length) {
      bajar("encaja_parcial");
      motivos.push(`El cargo combina ${propiasTitulo.join(", ")} con ${ajenasTitulo.join(", ")}, que no está en tu perfil.`);
    } else if (ajenasTexto.length) {
      bajar("encaja_parcial");
      motivos.push(`La descripción pide también ${ajenasTexto.join(", ")}, que no está en tu perfil.`);
    }
    if (!coincidencias.filter((c) => !GENERICAS.includes(c)).length) {
      bajar("encaja_parcial");
      motivos.push("No encontré tecnologías principales de tu perfil en la descripción.");
    }
  }

  // Inglés
  if (INGLES_ALTO.test(texto)) {
    const ingles = (perfil.idiomas || []).find((i) => /ingl|english/i.test(i.idioma || ""));
    if (!ingles) {
      bajar("encaja_parcial");
      motivos.push("Pide inglés avanzado o bilingüe y tu perfil maestro no declara inglés.");
    } else if (!NIVEL_INGLES_ALTO.test(normalizar(ingles.nivel))) {
      bajar("encaja_parcial");
      motivos.push(`Pide inglés avanzado o bilingüe; tu nivel declarado es ${ingles.nivel}.`);
    }
  }

  return {
    id: oferta.id,
    titulo: oferta.titulo,
    empresa: oferta.empresa,
    veredicto,
    motivos,
    coincidencias,
    modalidad: oferta.modalidad,
    salario: oferta.salario,
    contrato: oferta.contrato,
    url: oferta.url,
  };
}

/** Borrador de la nota al empleador, armado solo con datos del perfil maestro. */
export async function proponerRespuestas(id) {
  const evaluacion = await evaluarEncaje(id);
  if (evaluacion.estado) return evaluacion;
  const perfil = cargarPerfilMaestro();
  const dp = perfil.datos_personales || {};
  const pref = perfil.preferencias || {};

  const actual = (perfil.experiencia || []).find((e) => !e.fin);
  const logro = actual?.logros_es?.[0] || "";
  const stack = evaluacion.coincidencias.filter((c) => !GENERICAS.includes(c));
  const ia = evaluacion.coincidencias.includes("IA / LLM") ? perfil.respuestas_frecuentes?.uso_ia || "" : "";
  const titular = String(perfil.titular?.es || "").split("|")[0].trim();
  const desde = [dp.ciudad, dp.zona_horaria ? `(${dp.zona_horaria})` : ""].filter(Boolean).join(" ");
  const enlaces = [
    dp.portafolio && `Portafolio: ${dp.portafolio}`,
    dp.github && `GitHub: ${dp.github}`,
    dp.linkedin && `LinkedIn: ${dp.linkedin}`,
  ].filter(Boolean);

  let nota = [
    titular ? `${titular}.` : "",
    perfil.resumen?.es && !titular ? perfil.resumen.es : "",
    stack.length ? `Trabajo con ${stack.slice(0, 6).join(", ")}.` : "",
    actual ? `Actualmente en ${actual.empresa}${actual.descripcion_empresa ? ` (${actual.descripcion_empresa})` : ""}${logro ? `: ${logro.charAt(0).toLowerCase()}${logro.slice(1)}` : "."}` : "",
    ia,
    pref.modalidad || desde ? `Modalidad: ${[pref.modalidad, desde && `desde ${desde}`, pref.disponibilidad].filter(Boolean).join(", ")}.` : "",
    enlaces.join(" · "),
  ]
    .filter(Boolean)
    .join(" ");
  if (nota.length > 2000) nota = nota.slice(0, 1990) + "…";

  const requieren = evaluacion.motivos.filter((m) => /salario|ingl|residencia|presencial/i.test(m));
  return {
    id: evaluacion.id,
    titulo: evaluacion.titulo,
    empresa: evaluacion.empresa,
    veredicto: evaluacion.veredicto,
    respuestas: [{ pregunta: "nota", respuesta: nota, clasificacion: "respaldada por tu CV (perfil maestro)" }],
    requieren_tu_confirmacion: requieren,
    aviso: "Revisa la nota y los motivos antes de postular. Nada se envía sin tu confirmación.",
  };
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { evaluarEncaje, proponerRespuestas } from "./encaje.js";
import { buscarOfertas, detalleDeOferta, misPostulaciones, postularAOferta, preguntasDePostulacion, responderCuestionario } from "./ofertas.js";
import { registrarHerramientasPerfilMaestro } from "./perfil-maestro.js";
import { PORTAL } from "./config.js";
import { actualizarPerfil, borradorDesdeElempleo, compararPerfil, listarMisCv, subirCv, subirFoto, verMiPerfil } from "./perfil.js";
import { estadoDeSesion, iniciarSesion } from "./sesion.js";

const servidor = new McpServer({ name: "mcp-elempleo", version: "0.1.0" });

function responder(datos) {
  return { content: [{ type: "text", text: JSON.stringify(datos, null, 2) }] };
}

function herramienta(nombre, descripcion, esquema, funcion) {
  servidor.registerTool(nombre, { description: descripcion, inputSchema: esquema }, async (args) => {
    try {
      return responder(await funcion(args || {}));
    } catch (e) {
      return responder({ estado: e.estado || "error", mensaje: e.message });
    }
  });
}

/* Sesión */

herramienta(
  "estado-de-sesion",
  "Indica si hay una sesión válida de elempleo y el estado de la hoja de vida. Nunca muestra cookies.",
  {},
  () => estadoDeSesion()
);

herramienta(
  "iniciar-sesion",
  "Abre un navegador basado en Chromium (Chrome, Edge, Brave o Chromium) en la página de inicio de sesión de elempleo para que el usuario entre a mano (hay reCAPTCHA y verificación en dos pasos). Al detectar la sesión guarda las cookies en la carpeta de datos del MCP y cierra la ventana.",
  { espera_max_segundos: z.number().int().min(30).max(900).optional().describe("Tiempo máximo de espera (por defecto 300 s).") },
  ({ espera_max_segundos }) => iniciarSesion({ esperaMaxSegundos: espera_max_segundos })
);

/* Búsqueda */

herramienta(
  "buscar-ofertas",
  "Busca ofertas en elempleo.com (Colombia). Funciona sin sesión; con sesión indica si ya te postulaste.",
  {
    palabra: z.string().min(2).describe('Palabra clave, p. ej. "desarrollador", "react", "full stack".'),
    modalidad: z.enum(["remoto", "hibrido", "presencial", "todas"]).optional().describe("Por defecto: remoto."),
    contrato: z.enum(["todos", "indefinido", "definido", "prestacion_servicios", "aprendizaje", "obra_labor", "otro"]).optional(),
    salario_minimo_millones: z.number().min(0).optional().describe("Filtra rangos salariales cuyo máximo supere este valor (millones COP). Excluye 'salario confidencial'."),
    fecha: z.enum(["todas", "hoy_y_ayer", "una_semana", "dos_semanas", "un_mes", "mas_de_un_mes"]).optional(),
    pagina: z.number().int().min(1).optional(),
    por_pagina: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional(),
  },
  (a) => buscarOfertas(a)
);

herramienta(
  "detalle-de-oferta",
  "Devuelve la descripción completa de una oferta: requisitos, salario, contrato, modalidad y ciudad.",
  { id: z.number().int().describe("Id numérico de la oferta (p. ej. 1886772014).") },
  ({ id }) => detalleDeOferta(id)
);

herramienta(
  "evaluar-encaje",
  "Compara la oferta con el perfil maestro y sus preferencias (modalidad, salario mínimo según tipo de contrato, tecnologías declaradas y nivel de inglés) y devuelve encaja, encaja_parcial o no_encaja con los motivos.",
  { id: z.number().int() },
  ({ id }) => evaluarEncaje(id)
);

/* Postulación */

herramienta(
  "preguntas-de-postulacion",
  "Lee el formulario de postulación de la oferta (requiere sesión): tipo de postulación, nota opcional, archivos de CV disponibles y formularios adicionales. No envía nada.",
  { id: z.number().int() },
  ({ id }) => preguntasDePostulacion(id)
);

herramienta(
  "proponer-respuestas",
  "Redacta la nota al empleador a partir del perfil maestro y señala lo que requiere confirmación del usuario. Nunca inventa datos ni envía nada.",
  { id: z.number().int() },
  ({ id }) => proponerRespuestas(id)
);

herramienta(
  "postular-a-oferta",
  'Envía la postulación. Exige confirmación explícita del usuario para ESA oferta: confirmacion debe ser exactamente "POSTULAR <id>". Una oferta a la vez, sin reintentos automáticos.',
  {
    id: z.number().int(),
    confirmacion: z.string().describe('Exactamente "POSTULAR <id>", solo después de que el usuario aprobó la oferta y la nota.'),
    nota: z.string().max(2000).optional().describe("Nota al empleador aprobada por el usuario (opcional)."),
    adjunto_id: z.number().int().optional().describe("Id del archivo de CV (solo en postulación rápida)."),
  },
  (a) => postularAOferta(a)
);

herramienta(
  "responder-cuestionario",
  'Envía el cuestionario de filtro que la empresa pide tras postular (estado "requiere_cuestionario"). Las respuestas deben venir del usuario o estar confirmadas por él; confirmacion debe ser exactamente "CUESTIONARIO <id>".',
  {
    id: z.number().int().describe("Id de la oferta."),
    url: z.string().describe("cuestionario.url devuelta por postular-a-oferta."),
    respuestas: z
      .array(z.object({ pregunta_id: z.number().int(), respuesta: z.string().describe("Texto, o el valor/texto de la opción en preguntas cerradas.") }))
      .min(1),
    confirmacion: z.string().describe('Exactamente "CUESTIONARIO <id>", solo después de que el usuario aprobó las respuestas.'),
  },
  (a) => responderCuestionario(a)
);

herramienta(
  "mis-postulaciones",
  "Lista tus postulaciones en elempleo con su estado (en proceso, vencida, eliminada…).",
  { pagina: z.number().int().min(1).optional(), por_pagina: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional() },
  (a) => misPostulaciones(a)
);

/* Perfil maestro (estándar compartido: construir, guardar y ver) */

registrarHerramientasPerfilMaestro(servidor, { z, portal: PORTAL, borradorDesdePortal: borradorDesdeElempleo });

/* Hoja de vida en elempleo */

herramienta(
  "ver-mi-perfil",
  "Lee tu hoja de vida actual en elempleo: perfil profesional, experiencia, formación, cursos, idiomas, redes, habilidades y archivos.",
  {},
  () => verMiPerfil()
);

herramienta(
  "comparar-perfil",
  "Compara tu hoja de vida de elempleo con el perfil maestro y lista lo que falta, lo desactualizado y lo que sobra.",
  {},
  () => compararPerfil()
);

herramienta(
  "actualizar-perfil",
  "Actualiza una sección de la hoja de vida desde el perfil maestro. Sin aplicar devuelve el plan exacto (antes → después) para mostrarlo al usuario; con aplicar=true respalda en ~/.elempleo/respaldos/ y guarda. Solo borra los ids indicados en eliminar_ids. seguridad_social usa los datos que el usuario dé; nunca los supongas.",
  {
    seccion: z.enum(["perfil_profesional", "experiencia", "formacion", "cursos", "idiomas", "redes_sociales", "habilidades", "seguridad_social"]),
    aplicar: z.boolean().optional().describe("false (por defecto) = solo plan. true = guardar, tras la confirmación del usuario."),
    eliminar_ids: z.array(z.number().int()).optional().describe("Ids de entradas sobrantes que el usuario confirmó borrar."),
  },
  (a) => actualizarPerfil(a)
);

herramienta(
  "subir-foto",
  "Sube la foto indicada en datos_personales.foto del perfil maestro (JPG, PNG o GIF, máx. 3 MB). Sin aplicar solo muestra lo que haría.",
  { aplicar: z.boolean().optional() },
  (a) => subirFoto(a)
);

herramienta(
  "subir-cv",
  "Sube el CV en PDF del perfil maestro (cv_pdf: una ruta, o un objeto con varias versiones) a tus archivos de elempleo; opcionalmente reemplaza uno existente. Sin aplicar solo muestra lo que haría.",
  {
    version: z.string().optional().describe("Clave de cv_pdf cuando hay varias versiones; por defecto la primera."),
    aplicar: z.boolean().optional(),
    reemplazar_id: z.number().int().optional().describe("Id del archivo a reemplazar (ver listar-mis-cv)."),
  },
  (a) => subirCv(a)
);

herramienta("listar-mis-cv", "Lista los archivos de CV adjuntos en elempleo.", {}, () => listarMisCv());

await servidor.connect(new StdioServerTransport());

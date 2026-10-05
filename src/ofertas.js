import {
  SesionExpirada,
  decodificarHtml,
  extraerToken,
  jarraSesion,
  pedir,
  pedirJson,
  textoPlano,
  tokenDeFormulario,
} from "./http.js";

export const MODALIDAD = { todas: 0, presencial: 100, remoto: 101, hibrido: 102 };
export const CONTRATO = {
  todos: 0,
  indefinido: 1,
  definido: 2,
  prestacion_servicios: 3,
  aprendizaje: 4,
  obra_labor: 5,
  otro: 6,
};
export const FECHA = { todas: 0, hoy_y_ayer: 1, una_semana: 2, dos_semanas: 3, un_mes: 4, mas_de_un_mes: 6 };

// Rangos salariales de elempleo (millones COP): id -> [mínimo, máximo].
const RANGOS_SALARIO = {
  2: [0, 1], 3: [1, 1.5], 4: [1.5, 2], 5: [2, 2.5], 6: [2.5, 3], 7: [3, 3.5], 8: [3.5, 4], 9: [4, 4.5],
  10: [4.5, 5.5], 23: [5.5, 6], 27: [6, 8], 28: [8, 10], 29: [10, 12.5], 30: [12.5, 15], 31: [15, 18],
  32: [18, 21], 33: [21, 999],
};

function idsSalarioDesde(millones) {
  return Object.entries(RANGOS_SALARIO)
    .filter(([, [, max]]) => max > millones)
    .map(([id]) => id);
}

export function rangoSalario(texto) {
  if (!texto || /confidencial|a convenir/i.test(texto)) return null;
  const nums = [...String(texto).matchAll(/\$?\s*(\d+(?:[.,]\d+)?)/g)].map((m) => Number(m[1].replace(",", ".")));
  if (!nums.length) return null;
  if (/m[aá]s de/i.test(texto)) return [nums[0], null];
  if (/menos de/i.test(texto)) return [0, nums[0]];
  return [nums[0], nums[1] ?? nums[0]];
}

function resumenOferta(r) {
  return {
    id: r.id,
    titulo: decodificarHtml(r.title),
    empresa: r.notConfidential === false ? "Empresa confidencial" : decodificarHtml(r.companyName),
    ciudad: decodificarHtml(r.city),
    modalidad: decodificarHtml(r.idworkmodalitytxt) || (r.isRemote ? "Remoto" : r.isHybrid ? "Híbrido" : null),
    salario: r.withSalary ? decodificarHtml(r.salaryInfo) : "Salario confidencial",
    contrato: decodificarHtml(r.contracttypetxt),
    publicada: r.publishDate ? r.publishDate.slice(0, 10) : null,
    ya_postulado: Boolean(r.isApply),
    url: r.jobOfferUrl ? r.jobOfferUrl.split("?")[0] : null,
  };
}

async function tokenBusqueda(sesion) {
  const r = await pedir("/co/ofertas-empleo/", { sesion });
  const token = extraerToken(r.texto, "js-search-api-token");
  if (!token) throw new Error("No encontré el token de búsqueda en la página de elempleo.");
  return token;
}

export async function buscarOfertas({
  palabra,
  modalidad = "remoto",
  contrato = "todos",
  salario_minimo_millones,
  fecha = "todas",
  pagina = 1,
  por_pagina = 20,
}) {
  jarraSesion.cargar();
  const sesion = !jarraSesion.vacia();
  const ejecutar = async (usarSesion) => {
    const token = await tokenBusqueda(usarSesion);
    return pedirJson("/co/api/joboffers/findbyfilter", {
      metodo: "POST",
      tipo: "json",
      sesion: usarSesion,
      cabeceras: { __RequestVerificationToken: token },
      cuerpo: {
        jobOfferId: 0,
        query: palabra,
        queryOptional: null,
        salaryInfo: salario_minimo_millones ? idsSalarioDesde(salario_minimo_millones) : [],
        contractType: CONTRATO[contrato] ?? 0,
        workModality: MODALIDAD[modalidad] ?? 0,
        cities: [],
        sector: 0,
        industry: 0,
        publishDate: FECHA[fecha] ?? 0,
        positionLevel: 0,
        area: 0,
        countryId: 0,
        departmentId: 0,
        companyId: 0,
        jobOfferCode: null,
        pageIndex: pagina,
        pageSize: [20, 50, 100].includes(por_pagina) ? por_pagina : 20,
        sortExpression: "PublishDate_Desc",
      },
    });
  };

  let datos;
  try {
    datos = await ejecutar(sesion);
  } catch (e) {
    if (!(e instanceof SesionExpirada)) throw e;
    datos = await ejecutar(false);
  }

  const pag = datos.paginationInfo || {};
  return {
    total: pag.totalRecords ?? datos.results.length,
    pagina: pag.pageIndex ?? pagina,
    paginas: pag.totalPages ?? 1,
    con_sesion: Boolean(datos.results[0]?.userLogged),
    ofertas: datos.results.map(resumenOferta),
  };
}

export async function detalleDeOferta(id) {
  const datos = await pedirJson(`/co/api/joboffers/getjoboffer?jobOfferId=${encodeURIComponent(id)}`, { sesion: false });
  if (!datos || !datos.id) return { estado: "vencida", id, mensaje: "La oferta no existe o ya no está publicada." };
  const base = resumenOferta(datos);
  const share = datos.jobOfferDetail?.jobOfferShareModel || {};
  const descripcion = textoPlano(share.description || datos.description || "");
  return {
    ...base,
    descripcion,
    se_postula_en_web_externa: null,
    nota: "Si tiene preguntas de filtro o se postula en la web de la empresa, se sabe al leer el formulario (preguntas-de-postulacion) o al postular.",
  };
}

function leerFormulario(html, fragmentoAction) {
  const re = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cabeza = m[0].slice(0, m[0].indexOf(">") + 1);
    if (cabeza.includes(fragmentoAction)) {
      const action = decodificarHtml((cabeza.match(/action="([^"]+)"/) || [])[1] || "");
      return { html: m[0], action };
    }
  }
  return null;
}

/** Lee la página de la oferta con sesión: cómo se postula, CV adjuntos y si ya estás postulado. */
export async function leerPaginaDePostulacion(id) {
  const info = await pedirJson(`/co/api/joboffers/getjoboffer?jobOfferId=${encodeURIComponent(id)}`, { sesion: false });
  if (!info || !info.jobOfferUrl) return { estado: "vencida", id, mensaje: "La oferta no existe o ya no está publicada." };
  const r = await pedir(info.jobOfferUrl.split("?")[0]);
  const html = r.texto;
  const userId = (html.match(/ee-mod-user-id">\s*(\d+)/) || [])[1];
  const conSesion = /href="[^"]*LogOff/i.test(html) || (userId && userId !== "0");
  if (!conSesion) throw new SesionExpirada();

  if (!new RegExp(`jobOfferId=${id}`, "i").test(html)) {
    return { estado: "vencida", id, mensaje: "La oferta ya no está disponible para postular." };
  }

  const estadoPost = (() => {
    const m = html.match(/value="(\{\s*&quot;applypostlogin&quot;[^"]+)"/);
    try {
      return m ? JSON.parse(decodificarHtml(m[1])) : {};
    } catch {
      return {};
    }
  })();
  const aplicadaVisible = /id-ShowApplied[^"]*d-block/.test(html);
  const sinBoton = !/js-apply-quick-offer|js-apply-offer|js-apply-with-note/.test(html);
  const esRapida = /data-is-quick-offer-application="True"/i.test(html);

  const formNota = leerFormulario(html, "/JobOfferDetail/Save?");
  const formRapida = leerFormulario(html, "/JobOfferDetail/SaveQuickApplication");
  const adjuntos = [];
  if (formRapida) {
    const sel = formRapida.html.match(/<select[^>]*name="Attachments\.SelectedIds"[^>]*>([\s\S]*?)<\/select>/);
    if (sel) {
      for (const o of sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
        if (o[1] !== "-1") adjuntos.push({ id: Number(o[1]), nombre: textoPlano(o[2]) });
      }
    }
  }

  // Formularios ligados a la oferta que no son los conocidos: posibles preguntas de filtro.
  const otros = [];
  for (const f of html.matchAll(/<form\b[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/gi)) {
    const action = decodificarHtml(f[1]);
    if (!/JobOffer|Question|Pregunta|Filter|Test/i.test(action)) continue;
    if (/JobOfferDetail\/(Save\?|SaveQuickApplication)|ShareOffer|Alert|Share/i.test(action)) continue;
    const campos = [...f[2].matchAll(/name="([^"]+)"/g)].map((x) => x[1]).filter((n) => n !== "__RequestVerificationToken");
    otros.push({ action, campos: [...new Set(campos)] });
  }

  return {
    id: Number(id),
    url: r.url,
    html,
    ya_postulado: Boolean(estadoPost.offerapplied && aplicadaVisible) || (aplicadaVisible && sinBoton),
    es_postulacion_rapida: esRapida,
    formNota,
    formRapida,
    adjuntos,
    otros_formularios: otros,
  };
}

export async function preguntasDePostulacion(id) {
  const p = await leerPaginaDePostulacion(id);
  if (p.estado) return p;
  if (p.ya_postulado) return { estado: "ya_postulado", id: p.id, mensaje: "Ya te postulaste a esta oferta." };
  if (!p.formNota && !p.formRapida) {
    return { estado: "requiere_revision", id: p.id, mensaje: "No encontré el formulario de postulación en la página." };
  }

  const preguntas = [
    {
      id: "nota",
      tipo: "texto",
      obligatoria: false,
      max_caracteres: 2000,
      pregunta: "Cuéntanos, ¿por qué eres el candidato ideal para esta oferta?",
    },
  ];
  if (p.es_postulacion_rapida) {
    preguntas.push({
      id: "adjunto_id",
      tipo: "opcion",
      obligatoria: true,
      pregunta: "Hoja de vida (archivo) que recibirá la empresa",
      opciones: p.adjuntos,
    });
  }

  return {
    estado: p.otros_formularios.length ? "requiere_revision" : "listo",
    id: p.id,
    tipo_postulacion: p.es_postulacion_rapida ? "rapida (elige archivo de CV)" : "estandar (hoja de vida de elempleo)",
    preguntas,
    adjuntos_disponibles: p.adjuntos,
    formularios_desconocidos: p.otros_formularios,
    aviso:
      "La empresa recibe tu hoja de vida de elempleo. Revisa que esté actualizada (comparar-perfil) antes de postular." +
      (p.otros_formularios.length ? " Hay formularios adicionales que no reconozco: revísalos en la web antes de postular." : ""),
  };
}

const RESPUESTAS = {
  0: ["enviada", "Postulación enviada."],
  1: ["enviada", "Postulación enviada."],
  2: ["no_soportado", "La empresa recibe postulaciones en su propia web. Hay que terminar allí."],
  3: ["requiere_revision", "elempleo dice que tu hoja de vida está incompleta. Complétala y vuelve a intentarlo."],
  4: ["ya_postulado", "Ya estabas postulado a esta oferta."],
  5: ["requiere_revision", "elempleo pide un paso adicional (posibles preguntas o prueba). Ábrelo en la web."],
};

let postulando = false;

export async function postularAOferta({ id, confirmacion, nota = "", adjunto_id }) {
  const esperado = `POSTULAR ${id}`;
  if (String(confirmacion || "").trim().toUpperCase() !== esperado) {
    return {
      estado: "requiere_revision",
      id,
      mensaje: `No envío nada sin confirmación explícita. Pide confirmación al usuario y repite la llamada con confirmacion: "${esperado}".`,
    };
  }
  if (postulando) return { estado: "error", id, mensaje: "Ya hay una postulación en curso. Se postula una oferta a la vez." };
  if (nota && nota.length > 2000) return { estado: "requiere_revision", id, mensaje: "La nota supera los 2.000 caracteres." };

  postulando = true;
  try {
    const p = await leerPaginaDePostulacion(id);
    if (p.estado) return p;
    if (p.ya_postulado) return { estado: "ya_postulado", id: p.id, mensaje: "Ya te postulaste a esta oferta." };

    let datos;
    if (p.es_postulacion_rapida) {
      if (!p.formRapida) return { estado: "requiere_revision", id, mensaje: "No encontré el formulario de postulación rápida." };
      const adjunto = adjunto_id ?? p.adjuntos[0]?.id;
      if (!adjunto) return { estado: "requiere_revision", id, mensaje: "La oferta pide un archivo de CV y no tienes ninguno adjunto (usa subir-cv)." };
      const token = tokenDeFormulario(p.html, "/JobOfferDetail/SaveQuickApplication");
      datos = await pedirJson(p.formRapida.action, {
        metodo: "POST",
        cuerpo: {
          __RequestVerificationToken: token,
          "Attachments.SelectedIds": String(adjunto),
          IsQuickApplicationOffer: "True",
          ApplicationNote: nota || "undefined",
        },
      });
    } else {
      if (!p.formNota) return { estado: "requiere_revision", id, mensaje: "No encontré el formulario de postulación." };
      const token = tokenDeFormulario(p.html, "/JobOfferDetail/Save?");
      const cuerpo = { __RequestVerificationToken: token };
      if (nota) cuerpo.ApplicationNote = nota;
      datos = await pedirJson(p.formNota.action, { metodo: "POST", cuerpo });
    }

    if (datos.ModelInvalid) {
      return { estado: "requiere_revision", id, mensaje: "elempleo rechazó los datos enviados (formulario inválido).", detalle: datos };
    }
    const [estado, mensaje] = RESPUESTAS[datos.Response] || ["enviada", "elempleo aceptó la postulación."];
    const resultado = { estado, id: Number(id), mensaje, url_siguiente: datos.Url || null, codigo: datos.Response ?? null };
    if (datos.Url && /Questionnaires/i.test(datos.Url)) {
      const c = await leerCuestionario(datos.Url);
      return {
        ...resultado,
        estado: "requiere_cuestionario",
        mensaje:
          "La empresa pide un cuestionario obligatorio para completar la postulación. Muestra cada pregunta al usuario, propón respuestas solo con datos que él confirme y usa responder-cuestionario.",
        cuestionario: { url: datos.Url, preguntas: c.preguntas },
      };
    }
    return resultado;
  } finally {
    postulando = false;
  }
}

/** Lee el cuestionario de filtro que algunas empresas piden después de postular. */
export async function leerCuestionario(url) {
  const r = await pedir(url);
  const form = r.texto.match(/<form\b[^>]*action="([^"]*Questionnaires\/EndQuestionnaire[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) {
    if (/iniciar-sesion|js-login-form/i.test(r.texto) && !/LogOff/i.test(r.texto)) throw new SesionExpirada();
    return { estado: "sin_cuestionario", preguntas: [], mensaje: "No encontré un cuestionario pendiente en esa URL (puede que ya esté respondido o vencido)." };
  }
  const cuerpo = form[2];
  const ocultos = [...cuerpo.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)].map((m) => ({
    nombre: decodificarHtml((m[0].match(/name="([^"]*)"/) || [])[1] || ""),
    valor: decodificarHtml((m[0].match(/value="([^"]*)"/) || [])[1] || ""),
  }));
  const bloques = cuerpo.split(/(?=<input[^>]*name="\[\d+\]\.QuestionId")/i).slice(1);
  const preguntas = bloques.map((b) => {
    const indice = Number((b.match(/name="\[(\d+)\]\.QuestionId"/) || [])[1]);
    const id = Number((b.match(/name="\[\d+\]\.QuestionId"[^>]*value="(\d+)"/) || [])[1]);
    const cerrada = /IsCloseAnswer"[^>]*value="True"/i.test(b);
    const etiqueta = textoPlano((b.match(/<label[^>]*class="[^"]*control-label[^"]*"[^>]*>([\s\S]*?)<\/label>/i) || [])[1] || "")
      .replace(/^\s*\d+\.\s*/, "")
      .trim();
    const area = b.match(/<textarea[^>]*name="([^"]+)"[^>]*>/i);
    const opciones = [];
    for (const o of b.matchAll(/<input[^>]*type="(?:radio|checkbox)"[^>]*>/gi)) {
      const idInput = (o[0].match(/id="([^"]*)"/) || [])[1];
      const lbl = idInput ? b.match(new RegExp(`<label[^>]*for="${idInput}"[^>]*>([\\s\\S]*?)</label>`, "i")) : null;
      opciones.push({ campo: (o[0].match(/name="([^"]*)"/) || [])[1], valor: decodificarHtml((o[0].match(/value="([^"]*)"/) || [])[1]), texto: lbl ? textoPlano(lbl[1]).trim() : null });
    }
    const sel = b.match(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/i);
    if (sel) {
      for (const o of sel[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)) {
        if (o[1] !== "" && o[1] !== "-1") opciones.push({ campo: sel[1], valor: decodificarHtml(o[1]), texto: textoPlano(o[2]).trim() });
      }
    }
    return {
      indice,
      id,
      tipo: cerrada ? "opcion" : "texto",
      obligatoria: /\brequired\b|data-val-required/i.test(b),
      pregunta: etiqueta,
      ...(area ? { campo: area[1], max_caracteres: Number((b.match(/maxlength="(\d+)"/) || [])[1]) || 2000 } : {}),
      ...(opciones.length ? { opciones } : {}),
    };
  });
  return { estado: "listo", action: decodificarHtml(form[1]), ocultos, preguntas };
}

const RESPUESTAS_CUESTIONARIO = {
  1: ["otro_cuestionario", "Respuestas guardadas; la empresa pide otro cuestionario."],
  2: ["completada", "Cuestionario enviado: postulación completada."],
  4: ["completada_ats", "Cuestionario enviado: la empresa continúa el proceso en su propio sistema (ATS)."],
};

export async function responderCuestionario({ id, url, respuestas, confirmacion }) {
  const esperado = `CUESTIONARIO ${id}`;
  if (String(confirmacion || "").trim().toUpperCase() !== esperado) {
    return {
      estado: "requiere_revision",
      id,
      mensaje: `No envío respuestas sin confirmación explícita. Muestra preguntas y respuestas al usuario y repite con confirmacion: "${esperado}".`,
    };
  }
  if (!new RegExp(`JobOfferId=${id}\\b`, "i").test(url)) {
    return { estado: "requiere_revision", id, mensaje: "La URL del cuestionario no corresponde a esa oferta." };
  }
  const c = await leerCuestionario(url);
  if (c.estado !== "listo") return { ...c, id };

  const porId = new Map((respuestas || []).map((x) => [Number(x.pregunta_id), String(x.respuesta ?? "").trim()]));
  const faltan = c.preguntas.filter((p) => p.obligatoria && !porId.get(p.id));
  if (faltan.length) return { estado: "requiere_revision", id, mensaje: "Faltan respuestas obligatorias.", faltan: faltan.map((p) => ({ id: p.id, pregunta: p.pregunta })) };

  const cuerpo = new URLSearchParams();
  for (const o of c.ocultos) cuerpo.append(o.nombre, o.valor);
  for (const p of c.preguntas) {
    const valor = porId.get(p.id) ?? "";
    if (p.tipo === "texto") {
      if (valor.length > (p.max_caracteres || 2000)) return { estado: "requiere_revision", id, mensaje: `La respuesta a "${p.pregunta}" supera ${p.max_caracteres} caracteres.` };
      cuerpo.append(p.campo || `[${p.indice}].OpenAnswer`, valor);
    } else {
      const opcion = (p.opciones || []).find((o) => o.valor === valor || (o.texto && o.texto.toLowerCase() === valor.toLowerCase()));
      if (!opcion) return { estado: "requiere_revision", id, mensaje: `"${valor}" no es una opción válida para "${p.pregunta}".`, opciones: p.opciones };
      cuerpo.append(opcion.campo, opcion.valor);
    }
  }
  cuerpo.append("timeHasEnded", "false");

  const datos = await pedirJson(c.action, { metodo: "POST", cuerpo });
  const [estado, mensaje] = RESPUESTAS_CUESTIONARIO[datos.Response] || ["requiere_revision", "Respuesta inesperada de elempleo; revisa en mis-postulaciones."];
  const resultado = { estado, id: Number(id), mensaje, codigo: datos.Response ?? null };
  if (datos.Response === 1 && datos.Url) {
    const sig = await leerCuestionario(datos.Url);
    resultado.cuestionario = { url: datos.Url, preguntas: sig.preguntas };
  }
  return resultado;
}

export async function misPostulaciones({ pagina = 1, por_pagina = 20 } = {}) {
  const r = await pedir("/co/estadisticas/mis-procesos/");
  const token = extraerToken(r.texto, "js-application-api-token");
  if (!token) throw new SesionExpirada();
  const datos = await pedirJson("/co/api/jobOffersAplication/filters", {
    metodo: "POST",
    tipo: "json",
    cabeceras: { __RequestVerificationToken: token },
    cuerpo: {
      applicationId: 0,
      pageIndex: pagina,
      pageSize: [20, 50, 100].includes(por_pagina) ? por_pagina : 20,
      ordenColumn: "ApplicationDate_Desc",
      SortBy: 10,
      returnUrl: "",
      companyId: 0,
      universityId: 0,
    },
  });
  const pag = datos.paginationInfo || {};
  return {
    total: pag.totalRecords ?? datos.results.length,
    pagina: pag.pageIndex ?? pagina,
    paginas: pag.totalPages ?? 1,
    postulaciones: datos.results.map((x) => ({
      id_oferta: x.jobOfferId,
      titulo: decodificarHtml(x.jobOfferTitle),
      empresa: decodificarHtml(x.companyName),
      ciudad: decodificarHtml(x.city),
      fecha_postulacion: x.applicationDate,
      estado: decodificarHtml(x.jobOfferState),
      url: x.jobOfferUrl,
      detalle_proceso: x.applicationDetailUrl,
    })),
  };
}

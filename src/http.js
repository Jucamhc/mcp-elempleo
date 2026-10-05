import fs from "node:fs";
import path from "node:path";
import { ARCHIVO_COOKIES, BASE, USER_AGENT } from "./config.js";

export class SesionExpirada extends Error {
  constructor(mensaje = "La sesión de elempleo expiró o no existe. Usa iniciar-sesion.") {
    super(mensaje);
    this.estado = "sesion_expirada";
  }
}

export class BloqueoAntibot extends Error {
  constructor(mensaje = "elempleo respondió con un bloqueo o captcha. Me detengo sin reintentar.") {
    super(mensaje);
    this.estado = "bloqueo_antibot";
  }
}

// Cookies anónimas (búsqueda) y de sesión (cuenta) en jarras separadas.
class JarraCookies {
  constructor(archivo = null) {
    this.archivo = archivo;
    this.cookies = new Map();
    if (archivo) this.cargar();
  }

  cargar() {
    this.cookies.clear();
    if (!this.archivo || !fs.existsSync(this.archivo)) return;
    try {
      const lista = JSON.parse(fs.readFileSync(this.archivo, "utf8"));
      for (const c of lista) this.cookies.set(c.name, c);
    } catch {
      // Archivo corrupto: se trata como sin sesión.
    }
  }

  guardar() {
    if (!this.archivo) return;
    fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
    fs.writeFileSync(this.archivo, JSON.stringify([...this.cookies.values()], null, 2), { mode: 0o600 });
  }

  reemplazar(lista) {
    this.cookies.clear();
    for (const c of lista) this.cookies.set(c.name, c);
    this.guardar();
  }

  vacia() {
    return this.cookies.size === 0;
  }

  cabecera() {
    const ahora = Date.now() / 1000;
    return [...this.cookies.values()]
      .filter((c) => !c.expires || c.expires < 0 || c.expires > ahora)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  absorber(respuesta) {
    const lista = typeof respuesta.headers.getSetCookie === "function" ? respuesta.headers.getSetCookie() : [];
    if (!lista.length) return;
    for (const linea of lista) {
      const [par, ...atributos] = linea.split(";");
      const i = par.indexOf("=");
      if (i < 0) continue;
      const name = par.slice(0, i).trim();
      const value = par.slice(i + 1).trim();
      let expires = -1;
      for (const a of atributos) {
        const [k, v] = a.split("=");
        const clave = k.trim().toLowerCase();
        if (clave === "max-age") expires = Date.now() / 1000 + Number(v);
        if (clave === "expires" && expires === -1) expires = Date.parse(v) / 1000;
      }
      if (expires !== -1 && expires < Date.now() / 1000) this.cookies.delete(name);
      else this.cookies.set(name, { name, value, domain: ".elempleo.com", path: "/", expires });
    }
    this.guardar();
  }
}

export const jarraSesion = new JarraCookies(ARCHIVO_COOKIES);
export const jarraAnonima = new JarraCookies(null);

/**
 * Petición a elempleo siguiendo redirecciones a mano para conservar las cookies.
 * opciones: { metodo, cuerpo, tipo ('json'|'form'|'multipart'), cabeceras, sesion (bool), ajax (bool) }
 */
export async function pedir(ruta, opciones = {}) {
  const { metodo = "GET", cuerpo, tipo, cabeceras = {}, sesion = true, ajax = false } = opciones;
  const jarra = sesion ? jarraSesion : jarraAnonima;
  if (sesion) jarra.cargar();

  let url = ruta.startsWith("http") ? ruta : BASE + ruta;
  let met = metodo;
  let body;
  const h = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "es-CO,es;q=0.9",
    Accept: ajax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    ...cabeceras,
  };
  if (ajax) h["X-Requested-With"] = "XMLHttpRequest";

  if (cuerpo !== undefined) {
    if (tipo === "json") {
      h["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(cuerpo);
    } else if (tipo === "multipart") {
      body = cuerpo; // FormData: fetch pone el boundary
    } else {
      h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      body = cuerpo instanceof URLSearchParams ? cuerpo.toString() : new URLSearchParams(cuerpo).toString();
    }
  }

  for (let salto = 0; salto < 6; salto++) {
    const cookie = jarra.cabecera();
    const resp = await fetch(url, {
      method: met,
      headers: { ...h, ...(cookie ? { Cookie: cookie } : {}), Referer: BASE + "/co/" },
      body: met === "GET" ? undefined : body,
      redirect: "manual",
    });
    jarra.absorber(resp);

    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      const destino = new URL(resp.headers.get("location"), url).toString();
      if (sesion && /iniciar-sesion|Account\/Login/i.test(destino)) throw new SesionExpirada();
      url = destino;
      if (resp.status !== 307 && resp.status !== 308) {
        met = "GET";
        body = undefined;
      }
      continue;
    }

    const texto = await resp.text();
    if (resp.status === 403 || resp.status === 429 || /captcha|cf-chl|Access Denied/i.test(texto.slice(0, 3000)) && resp.status >= 400) {
      throw new BloqueoAntibot(`elempleo respondió ${resp.status}. Me detengo sin reintentar.`);
    }
    if (resp.status === 401 && sesion) throw new SesionExpirada();
    return { status: resp.status, url, texto, tipo: resp.headers.get("content-type") || "" };
  }
  throw new Error("Demasiadas redirecciones al consultar elempleo.");
}

export async function pedirJson(ruta, opciones = {}) {
  const r = await pedir(ruta, { ajax: true, ...opciones });
  if (!/json/i.test(r.tipo)) {
    if (opciones.sesion !== false && /iniciar-sesion|js-login-form/i.test(r.texto)) throw new SesionExpirada();
    throw new Error(`Respuesta inesperada de elempleo (${r.status}) en ${ruta}.`);
  }
  const datos = JSON.parse(r.texto);
  if (r.status >= 400) {
    const err = new Error(datos.message || `Error ${r.status} en ${ruta}`);
    err.status = r.status;
    err.datos = datos;
    throw err;
  }
  return datos;
}

export function decodificarHtml(texto) {
  if (texto == null) return texto;
  return String(texto)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

export function textoPlano(html) {
  return decodificarHtml(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Token anti-falsificación dentro de un contenedor con la clase dada (o el primero de la página). */
export function extraerToken(html, claseContenedor = null) {
  let zona = html;
  if (claseContenedor) {
    const i = html.indexOf(claseContenedor);
    if (i < 0) return null;
    zona = html.slice(i, i + 2000);
  }
  const m = zona.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

/** Token del formulario cuyo action contiene el texto dado. */
export function tokenDeFormulario(html, fragmentoAction) {
  const re = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cabeza = m[0].slice(0, m[0].indexOf(">") + 1);
    if (cabeza.includes(fragmentoAction)) {
      const t = m[0].match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
      if (t) return t[1];
    }
  }
  return null;
}

/** Valor de un atributo data-* (decodificado) del primer elemento que lo tenga. */
export function atributoData(html, nombre) {
  const m = html.match(new RegExp(`${nombre}="([^"]*)"`));
  return m ? decodificarHtml(m[1]) : null;
}

/** Serializa como jQuery.param (arreglos de objetos incluidos). */
export function paramEstiloJquery(objeto) {
  const p = new URLSearchParams();
  const agregar = (clave, valor) => {
    if (Array.isArray(valor)) valor.forEach((v, i) => agregar(typeof v === "object" && v !== null ? `${clave}[${i}]` : `${clave}[]`, v));
    else if (valor !== null && typeof valor === "object") for (const k of Object.keys(valor)) agregar(`${clave}[${k}]`, valor[k]);
    else p.append(clave, valor == null ? "" : String(valor));
  };
  for (const k of Object.keys(objeto)) agregar(k, objeto[k]);
  return p;
}

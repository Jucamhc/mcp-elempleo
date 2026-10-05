import fs from "node:fs";
import { BASE, CARPETA_DATOS, CHROME, PERFIL_CHROME } from "./config.js";
import { SesionExpirada, jarraSesion, pedirJson } from "./http.js";

export async function estadoDeSesion() {
  jarraSesion.cargar();
  if (jarraSesion.vacia()) {
    return { estado: "sesion_expirada", sesion: false, mensaje: "No hay sesión guardada. Usa iniciar-sesion." };
  }
  try {
    const datos = await pedirJson("/co/Persons/ProfessionalProfile/Get");
    const info = datos.resumeInfo || {};
    return {
      estado: "ok",
      sesion: true,
      hoja_de_vida: {
        estado: info.indicator?.statusText || null,
        ultima_actualizacion: info.lastUpdate || null,
        completitud: datos.progressBar?.completePercent ?? null,
        profesion: datos.result?.professionName?.trim() || null,
      },
    };
  } catch (e) {
    if (e instanceof SesionExpirada) return { estado: "sesion_expirada", sesion: false, mensaje: e.message };
    throw e;
  }
}

/**
 * Abre Chrome con un perfil propio del MCP para que la persona inicie sesión a mano
 * (elempleo usa reCAPTCHA y verificación en dos pasos). Al detectar la sesión, guarda las cookies.
 */
export async function iniciarSesion({ esperaMaxSegundos = 300 } = {}) {
  if (!CHROME) {
    throw new Error("No encontré un navegador basado en Chromium (Chrome, Edge, Brave o Chromium). Instala uno o define CHROME_PATH con la ruta de su ejecutable.");
  }
  const puppeteer = (await import("puppeteer-core")).default;
  fs.mkdirSync(PERFIL_CHROME, { recursive: true });

  const navegador = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: PERFIL_CHROME,
    defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1100,850"],
  });

  try {
    const pagina = await navegador.newPage();
    await pagina.bringToFront();
    try {
      await pagina.goto(`${BASE}/co/iniciar-sesion`, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      process.stderr.write(`[elempleo] No cargó el login automáticamente (${e.message}). Escribe elempleo.com en la ventana.\n`);
    }
    for (const otra of await navegador.pages()) {
      if (otra !== pagina && otra.url() === "about:blank") await otra.close().catch(() => {});
    }
    process.stderr.write("[elempleo] Ventana de inicio de sesión abierta.\n");

    const limite = Date.now() + esperaMaxSegundos * 1000;
    let conectado = false;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!navegador.connected) break;
      let paginas = [];
      try {
        paginas = await navegador.pages();
      } catch {
        continue;
      }
      for (const p of paginas) {
        try {
          if (!p.url().startsWith(BASE)) continue;
          const dentro = await p.evaluate(() => {
            const el = document.querySelector(".ee-mod-user-id, .js-user-id");
            const id = el ? el.textContent.trim() : "";
            return Boolean(document.querySelector('a[href*="LogOff"]')) || (id !== "" && id !== "0");
          });
          if (dentro && !/iniciar-sesion/i.test(p.url())) conectado = true;
        } catch {
          // La página está navegando; se reintenta en la siguiente vuelta.
        }
      }
      if (conectado) break;
    }

    if (!conectado) {
      return {
        estado: "sesion_expirada",
        sesion: false,
        mensaje: navegador.connected
          ? `No detecté el inicio de sesión en ${esperaMaxSegundos} s. Vuelve a llamar a iniciar-sesion.`
          : "Se cerró la ventana de Chrome antes de iniciar sesión.",
      };
    }

    process.stderr.write("[elempleo] Sesión detectada; guardando cookies.\n");
    const cliente = await pagina.createCDPSession();
    const { cookies } = await cliente.send("Network.getAllCookies");
    const propias = cookies
      .filter((c) => c.domain.endsWith("elempleo.com"))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires }));
    jarraSesion.reemplazar(propias);
  } finally {
    if (navegador.connected) await navegador.close();
  }

  const estado = await estadoDeSesion();
  return { ...estado, mensaje: estado.sesion ? `Sesión guardada en ${CARPETA_DATOS}.` : estado.mensaje };
}

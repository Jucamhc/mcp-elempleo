import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));

export const BASE = "https://www.elempleo.com";
export const PAIS = "/co";

export const CARPETA_PAQUETE = path.resolve(aqui, "..");

// Sesión, caché y respaldos en la carpeta del usuario (fuera de carpetas sincronizadas).
export const CARPETA_DATOS = process.env.ELEMPLEO_DATA_DIR || path.join(os.homedir(), ".elempleo");
export const ARCHIVO_COOKIES = path.join(CARPETA_DATOS, "cookies.json");
export const ARCHIVO_CATALOGOS = path.join(CARPETA_DATOS, "catalogos.json");
export const PERFIL_CHROME = path.join(CARPETA_DATOS, "chrome-profile");
export const CARPETA_RESPALDOS = path.join(CARPETA_DATOS, "respaldos");

export const PORTAL = "elempleo";

// Cualquier navegador basado en Chromium sirve para el inicio de sesión manual.
export const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ].find((ruta) => fs.existsSync(ruta));

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

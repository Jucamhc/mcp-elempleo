# mcp-elempleo

Servidor MCP para [elempleo.com](https://www.elempleo.com) (Colombia). Con él puedes:

- Buscar ofertas, ver su detalle y evaluar si encajan con tu perfil.
- Postular, una oferta a la vez y con tu confirmación explícita.
- Mantener tu hoja de vida al día a partir de un archivo único con tus datos: el **perfil maestro**.

Funciona con cualquier cuenta de elempleo. Ningún dato personal está escrito en el código: todo sale del perfil maestro o de la hoja de vida que ya tengas en elempleo.

## Instalación

Requisitos: Node.js 20 o superior y un navegador basado en Chromium (Chrome, Edge, Brave o Chromium), que solo se usa para iniciar sesión.

```bash
git clone https://github.com/Jucamhc/mcp-elempleo.git
cd mcp-elempleo
npm install
```

Es autónomo: incluye el estándar del perfil maestro (`src/perfil-maestro.js`, `perfil-maestro.schema.json` y [`PERFIL-MAESTRO.md`](PERFIL-MAESTRO.md)). Los demás MCP de empleo traen la misma copia, así que todos comparten el mismo perfil.

Regístralo en tu cliente MCP (por ejemplo `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "elempleo": {
      "command": "node",
      "args": ["/ruta/a/mcp-elempleo/src/index.js"],
      "env": { "PERFIL_MAESTRO": "/ruta/a/mi/perfil-maestro.json" }
    }
  }
}
```

### Variables de entorno (todas opcionales)

| Variable | Por defecto | Para qué |
|---|---|---|
| `PERFIL_MAESTRO` | `~/.perfil-maestro/perfil-maestro.json` | Ruta de tu perfil maestro (la misma para todos los MCP) |
| `RAIZ_ARCHIVOS` | carpeta del perfil maestro | Base para las rutas relativas de `foto` y `cv_pdf` |
| `ELEMPLEO_DATA_DIR` | `~/.elempleo` | Sesión (cookies), caché de catálogos, perfil del navegador y respaldos |
| `CHROME_PATH` | se detecta | Ruta del ejecutable del navegador si no está en la ubicación habitual |

La sesión y los respaldos quedan en `~/.elempleo/`, fuera de carpetas sincronizadas. El MCP nunca muestra cookies ni credenciales.

## Primeros pasos

1. `iniciar-sesion`: abre el navegador en el login de elempleo. Entras a mano (hay reCAPTCHA y verificación en dos pasos) y el MCP guarda la sesión.
2. Si aún no tienes perfil maestro, `construir-perfil-maestro` te pide una fuente:
   - **La URL de tu LinkedIn.** LinkedIn no deja leer perfiles automáticamente, así que el MCP te indica cómo exportarlo con "Más → Guardar en PDF".
   - **Tu CV en PDF y tu foto.** El MCP extrae el texto y el asistente arma el perfil según el estándar para que lo revises.
   - **Lo que ya tienes en elempleo** (`desde_portal: true`).

   Cuando lo apruebes, `guardar-perfil-maestro` lo valida y lo guarda con la foto y el CV.
3. `comparar-perfil`: muestra qué falta, qué está desactualizado y qué sobra en elempleo frente al perfil maestro.
4. `actualizar-perfil` por sección: primero sin `aplicar`, para ver el plan antes → después; luego con `aplicar: true`.

## Perfil maestro

Es un JSON que sirve como única fuente de verdad y sigue el [estándar compartido](PERFIL-MAESTRO.md). El MCP lo lee y nunca inventa datos. Campos que usa elempleo (ver `perfil-maestro.ejemplo.json`):

| Campo | Uso |
|---|---|
| `datos_personales` | `ciudad`, `pais`, `zona_horaria`, enlaces (`linkedin`, `github`, `portafolio`…) y `foto` (ruta relativa o absoluta) |
| `titular.es`, `resumen.es` | Perfil profesional y primera línea de la nota al empleador |
| `profesion` | Opcional: nombre exacto en el catálogo de elempleo. Si falta, se usa tu título más alto |
| `experiencia[]` | `empresa`, `cargo`, `cargo_oficial`, `inicio`/`fin` (`AAAA-MM`, `fin: null` = actual), `ubicacion`, `descripcion_empresa`, `logros_es[]`, `tecnologias[]` |
| `formacion[]` | `institucion`, `titulo_es`, `inicio`, `fin`, `graduado`, `mostrar_en_cv` |
| `certificaciones[]` | `nombre`, `emisor`, `fecha` |
| `aptitudes`, `habilidades_clave` | `aptitudes` (grupos libres) y `habilidades_clave.tecnicas`/`blandas` (máx. 20 en elempleo, 40 caracteres cada una) |
| `idiomas[]` | `idioma` y `nivel` (Nativo, Básico, Intermedio o Avanzado) |
| `preferencias` | `modalidad` (p. ej. "Solo remoto"), `salario_minimo_laboral_cop`, `salario_minimo_prestacion_cop`, `acepta_reubicacion`, `puede_viajar`, `paises`, `disponibilidad` |
| `seguridad_social` | `pension_obligatoria`, `cesantias`, `pension_voluntaria`, `eps`, `caja_compensacion` (nombres como aparecen en elempleo) |
| `cv_pdf` | Ruta del PDF, o un objeto `{ "version": "ruta" }` si tienes varias |
| `respuestas_frecuentes` | Respuestas reutilizables (p. ej. `uso_ia`) |

### Cómo se eligen las opciones de los catálogos de elempleo

elempleo pide elegir cargo equivalente, sector, ciudad, nivel educativo, área de cursos y profesión de sus propias listas. El MCP elige la opción que más palabras comparte con tu dato y la muestra en el plan para que la revises. Si quieres fijarla, agrega el nombre exacto del catálogo en `portales.elempleo` (los demás MCP ignoran esa clave):

- En `experiencia[].portales.elempleo`: `cargo_equivalente`, `sector` y `ciudad`.
- En `formacion[].portales.elempleo`: `nucleo_conocimiento`. El nivel y la ciudad usan los campos estándar `nivel` y `ciudad`.
- En `certificaciones[].portales.elempleo`: `area`; o un `area_cursos` general en `portales.elempleo` de la raíz.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `estado-de-sesion`, `iniciar-sesion` | Sesión |
| `buscar-ofertas`, `detalle-de-oferta` | Búsqueda (sin sesión) |
| `evaluar-encaje` | Compara la oferta con tus preferencias (modalidad, salario según contrato, tecnologías declaradas e inglés) |
| `preguntas-de-postulacion`, `proponer-respuestas` | Lee el formulario de postulación y redacta la nota con datos del perfil maestro |
| `postular-a-oferta` | Exige `confirmacion: "POSTULAR <id>"`. Una a la vez, sin reintentos. Si la empresa pide cuestionario devuelve `requiere_cuestionario` con las preguntas |
| `responder-cuestionario` | Envía el cuestionario de filtro posterior a la postulación. Exige `confirmacion: "CUESTIONARIO <id>"` y respuestas aprobadas por el usuario |
| `mis-postulaciones` | Estado de tus postulaciones |
| `construir-perfil-maestro`, `guardar-perfil-maestro`, `ver-perfil-maestro` | Herramientas estándar del perfil maestro: crearlo desde LinkedIn, un CV en PDF con foto o elempleo; validarlo y guardarlo; revisarlo |
| `ver-mi-perfil`, `comparar-perfil`, `actualizar-perfil` | Hoja de vida. Secciones: `perfil_profesional`, `experiencia`, `formacion`, `cursos`, `idiomas`, `redes_sociales`, `habilidades`, `seguridad_social` |
| `subir-foto`, `subir-cv`, `listar-mis-cv` | Foto y archivos |

Toda escritura respalda antes lo que había (en `~/.elempleo/respaldos/`) y solo borra los ids que pases en `eliminar_ids`.

## Referencia técnica

elempleo no tiene API pública; la web usa una API interna (ASP.NET MVC con tokens anti-falsificación).

### Búsqueda (sin sesión)

1. `GET /co/ofertas-empleo/?Trabajo=<palabra>` da las cookies y el token de `<span class="js-search-api-token">`.
2. `POST /co/api/joboffers/findbyfilter` con la cabecera `__RequestVerificationToken` y el cuerpo:

   ```json
   {"query":"desarrollador","salaryInfo":[],"contractType":0,"workModality":101,
    "cities":[],"publishDate":0,"pageIndex":1,"pageSize":20,"sortExpression":"PublishDate_Desc"}
   ```

| Filtro | Valores |
|---|---|
| `workModality` | 0 todos, 100 presencial, 102 híbrido, 101 remoto |
| `contractType` | 0 todos, 1 indefinido, 2 definido, 3 prestación de servicios, 4 aprendizaje, 5 obra o labor, 6 otro |
| `salaryInfo` (millones COP) | 2 menos de 1 · 3 1–1,5 · … · 10 4,5–5,5 · 23 5,5–6 · 27 6–8 · 28 8–10 · 29 10–12,5 · 30 12,5–15 · 31 15–18 · 32 18–21 · 33 más de 21 |
| `publishDate` | 1 hoy y ayer, 2 una semana, 3 dos semanas, 4 un mes, 6 más de un mes |

Detalle: `GET /co/api/joboffers/getjoboffer?jobOfferId=<id>`.

### Postulación (con sesión)

- Postulación rápida: `POST /co/JobOffers/JobOfferDetail/SaveQuickApplication?JobOfferId=&CurrentAttachmentCVId=` con `Attachments.SelectedIds`.
- Normal: `POST /co/JobOffers/JobOfferDetail/Save?jobOfferId=` con `ApplicationNote` (opcional, máx. 2.000 caracteres).
- `Response`: 1 enviada, 2 se postula en la web de la empresa, 3 hoja de vida incompleta, 4 ya postulado, 5 redirige a un paso adicional (por verificar).
- Mis postulaciones: `POST /co/api/jobOffersAplication/filters` con el token de `.js-application-api-token`.

### Hoja de vida

Página `/co/hoja-de-vida`. Los catálogos vienen en atributos `data-*` de `.js-conf` (ciudades, cargos, sectores, instituciones, profesiones, áreas de cursos, habilidades, países).

| Sección | Endpoint |
|---|---|
| Foto | `/co/Persons/PersonalInformation/LoadAsyncPhoto` (multipart, campo `Image`; token del formulario `LoadSyncPhoto`) |
| Perfil profesional | `/co/Persons/ProfessionalProfile/Save` |
| Experiencia laboral | `/co/Persons/LaboralExperience/Save` (borrar: `/Delete`) |
| Educación formal | `/co/Persons/FormalEducation/Save` (borrar: `/Delete`) |
| Cursos y diplomados | `/co/Persons/NonFormalEducation/Save` (borrar: `/Delete`) |
| Idiomas | `/co/Persons/LanguageKnowledge/Save`; idiomas disponibles: `/GetAvaibleLanguages` |
| Redes sociales | `/co/Persons/SocialNetwork/Save` con `model[i][Id]`, `model[i][Url]` |
| Habilidades | `/co/Persons/Skills/Save` con `Skills[i][id]`, `Skills[i][name]` (`id` 0 = texto libre; el catálogo solo trae habilidades blandas) |
| Seguridad social | `/co/Persons/SocialSecurity/Save` con los `SelectedIds` de pensión, cesantías, EPS y caja, y `ContributeToVoluntaryPensionFund` |
| Archivos (CV) | `/co/Persons/Attachment/SaveAttachment` (multipart, campo `File`; borrar: `/Delete`) |

Fechas en `dd/mm/aaaa`; formularios en `x-www-form-urlencoded` al estilo `jQuery.param`.

## Pendiente de verificar

- Qué trae el código de respuesta `5` al postular (posibles preguntas de filtro o pruebas).

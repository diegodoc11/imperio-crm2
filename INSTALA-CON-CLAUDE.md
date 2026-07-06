# 🤖 Instala Imperio CRM con Claude

Así trabajamos en Imperio: tú das la orden y la IA ejecuta.

1. Abre **Claude Code** (la terminal o [claude.ai/code](https://claude.ai/code)) en una carpeta nueva.
2. Copia **todo** el bloque de abajo y pégaselo.
3. Responde lo que Claude te pregunte (el nombre de tu negocio, tu color, tu país).

---

```text
Quiero instalar Imperio CRM: mi CRM propio, gratis, en mi cuenta de Cloudflare.
El código está en https://github.com/diegodoc11/imperio-crm

Hazlo tú por mí, explicándome cada paso en español sencillo (no soy programador):

1. Descarga el repo en esta carpeta y corre `npm install`.

2. Revisa si estoy conectado a Cloudflare con `npx wrangler whoami`.
   - Si no estoy conectado, dime que escriba `! npx wrangler login` para conectarme.
   - Si no tengo cuenta, guíame para crearla gratis en dash.cloudflare.com/sign-up.

3. Crea mi base de datos con `npx wrangler d1 create imperio-crm-db` y pega el
   database_id que devuelva en wrangler.jsonc.

4. Pregúntame el nombre de mi negocio, mi color de marca favorito y mi país.
   Con eso llena BUSINESS_NAME, BRAND_COLOR y TIMEZONE en wrangler.jsonc.

5. Despliega con `npx wrangler deploy`.

6. Dame el link de mi Torre de Control (mi-worker.workers.dev/torre) y dime que
   entre a crear mi clave de acceso. La clave la escribo yo en el navegador:
   no me la pidas ni la guardes.

7. Cuando yo te confirme que ya creé mi clave, haz una prueba de humo: manda un
   lead de prueba a POST /lead con external_id "test_instalacion", pídeme que
   confirme que lo veo en la Torre, y luego bórralo de la base con wrangler.

8. Al final entrégame:
   - El link de mi Torre de Control para guardarlo en favoritos.
   - El archivo ejemplos/formulario.html adaptado con MI URL, listo para mi landing.
   - Una nota en tu memoria de que mi Imperio CRM vive en esta carpeta y cuál es mi URL.
```

---

### ¿Algo se dañó después?

Pídeselo a Claude en la misma carpeta: *"mi Imperio CRM está fallando, revísalo y arréglalo"*. Para actualizarlo cuando salga versión nueva: *"actualiza mi Imperio CRM con la última versión del repo"*.

— **Diego Osorio · Nómadas Millonarios · Imperio**

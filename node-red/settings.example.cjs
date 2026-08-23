/**
 * TEMPLATE - copy to settings.cjs and adjust.
 *
 * Node-RED settings for the SIT314 transport flow.
 *
 * What: points Node-RED at node-red/flows.json and supplies the MQTT broker
 *       host/port through environment variables.
 * Why:  the SAME flow must run against the local development broker and
 *       against AWS IoT Core. Only the broker configuration changes, which is
 *       exactly the property that makes Node-RED portable in this architecture.
 *
 * This file contains NO secrets. Certificate paths for AWS IoT come from
 * environment variables and the files themselves stay in certs/ (git-ignored).
 *
 * Run with:  npm run node-red
 */
const path = require('node:path');

// Defaults suitable for local development; override in .env or the shell.
process.env.MQTT_HOST = process.env.MQTT_LOCAL_HOST || process.env.MQTT_HOST || 'localhost';
process.env.MQTT_PORT = process.env.MQTT_LOCAL_PORT || process.env.MQTT_PORT || '1883';
process.env.MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || 'sit314-node-red';

module.exports = {
  // Load the flow that lives in the repository rather than a copy in userDir,
  // so what is committed is what runs.
  flowFile: path.join(__dirname, 'flows.json'),
  flowFilePretty: true,
  userDir: path.join(__dirname, 'data'),

  uiPort: process.env.NODE_RED_PORT || 1880,
  // Bind to loopback only. This editor has no authentication configured and
  // must not be exposed on a network interface - see docs/SECURITY.md.
  uiHost: process.env.NODE_RED_HOST || '127.0.0.1',

  logging: {
    console: {
      level: process.env.NODE_RED_LOG_LEVEL || 'info',
      metrics: false,
      audit: false,
    },
  },

  // node.warn() output from the flow is what produces the [ACCEPTED] and
  // [REJECTED] evidence lines in the console.
  functionGlobalContext: {},
  functionExternalModules: false,

  exportGlobalContextKeys: false,
  credentialSecret: false,

  editorTheme: {
    projects: { enabled: false },
    page: { title: 'SIT314 transport processing' },
    header: { title: 'SIT314 multimodal transport' },
  },
};

// ---------------------------------------------------------------------------
// To connect to AWS IoT Core instead of the local broker, set MQTT_HOST to the
// ATS endpoint and MQTT_PORT to 8883, then enable TLS on the broker config node
// in the editor and attach a tls-config node pointing at the files in certs/.
// See node-red/README.md. Never place certificate CONTENT in this file.
// ---------------------------------------------------------------------------

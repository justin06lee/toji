'use strict';

// Byakugan includes live form values in its compact page manifest. Those values are useful
// for ordinary automation, but a password manager must never send a filled secret back to
// the model on the next observation. Redact every form value rather than trying to guess
// which fields are passwords: login forms often omit or mislabel the input type.
function redactManifestValues(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/\svalue="(?:\\.|[^"\\])*"/g, ' value="[redacted]"');
}

module.exports = { redactManifestValues };

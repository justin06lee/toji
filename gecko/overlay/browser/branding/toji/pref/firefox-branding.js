/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's branding prefs. The file name is fixed by branding-common.mozbuild.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");
pref("app.update.url.manual", "https://github.com/justin06lee/toji");
pref("app.update.url.details", "https://github.com/justin06lee/toji");
pref("app.releaseNotesURL", "https://github.com/justin06lee/toji/commits/master");
pref("app.releaseNotesURL.aboutDialog", "https://github.com/justin06lee/toji/commits/master");
pref("app.support.baseURL", "https://github.com/justin06lee/toji#");
pref("app.feedback.baseURL", "https://github.com/justin06lee/toji/issues");
pref("app.update.checkInstallTime.days", 2);
pref("app.update.badgeWaitTime", 0);

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 5);

// Autoconfig: toji.cfg sits next to the app's resources and locks the prefs
// that strip Mozilla's services. The sandbox stays on: it only needs prefs.
pref("general.config.filename", "toji.cfg");
pref("general.config.obscure_value", 0);

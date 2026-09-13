/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Process script (TojiAsk.init loads it into every process): registers toji:
// in content processes, so their docshells load toji: pages instead of
// handing them to another app. See ContentAskProtocol in TojiAsk.sys.mjs.

"use strict";

ChromeUtils.importESModule("resource:///modules/toji/TojiAsk.sys.mjs").TojiAsk.initContentProcess();

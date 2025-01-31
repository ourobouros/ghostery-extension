/**
 * Click2Play Builder
 *
 * Ghostery Browser Extension
 * https://www.ghostery.com/
 *
 * Copyright 2019 Ghostery, Inc. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0
 */

/* eslint no-use-before-define: 0 */

import { reject } from 'underscore';
import bugDb from '../classes/BugDb';
import c2pDb from '../classes/Click2PlayDb';
import conf from '../classes/Conf';
import globals from '../classes/Globals';
import Policy from '../classes/Policy';
import tabInfo from '../classes/TabInfo';
import { log } from './common';
import { sendMessage, processUrl, injectScript } from './utils';
import c2p_tpl from '../../app/templates/click2play.html';
import c2p_images from '../../app/data-images/click2play';

const policy = new Policy();

/**
 * Builds Click2Play templates for a given tab_id.
 *
 * Restricted Sites: Only show the "allow once" option, since blacklisting overrides
 * site-specific tracker allow settings.
 *
 * @memberOf BackgroundUtils
 *
 * @param  {Object} details 	request parameters
 * @param  {number} app_id 		tracker id
 */
export function buildC2P(details, app_id) {
	const { tab_id } = details;
	let c2pApp = c2pDb.db.apps && c2pDb.db.apps[app_id];

	if (!c2pApp) {
		return;
	}

	// click-to-play for social buttons might be disabled
	if (!conf.enable_click2play_social) {
		c2pApp = reject(c2pApp, c2pAppDef => !!c2pAppDef.button);
	}

	if (!c2pApp.length) {
		return;
	}
	const app_name = bugDb.db.apps[app_id].name;
	const c2pHtml = [];
	const tab_host = tabInfo.getTabInfo(tab_id, 'host');
	const blacklisted = !!policy.blacklisted(tab_host);

	// Generate the templates for each c2p definition (could be multiple for an app ID)
	c2pApp.forEach((c2pAppDef) => {
		const tplData = {
			blacklisted, // if the site is blacklisted, don't show allow_always button
			button: !!c2pAppDef.button,
			ghostery_blocked_src: c2p_images.ghosty_blocked,
			allow_always_src: c2p_images.allow_unblock,
			allow_always_title: t('click2play_allow_always_tooltip')
		};
		if (c2pAppDef.button) {
			tplData.allow_once_title = t('click2play_allow_once_button_tooltip', app_name);
			const buttonName = c2pAppDef.button.substring(0, c2pAppDef.button.indexOf('.png'));
			tplData.allow_once_src = c2p_images[buttonName];
		} else {
			tplData.allow_once_title = t('click2play_allow_once_tooltip');
			tplData.allow_once_src = c2p_images.allow_once;

			tplData.ghostery_blocked_title = t('click2play_blocked', app_name);

			if (c2pAppDef.type) {
				tplData.click2play_text = t(`click2play_${c2pAppDef.type}_form`, app_name);
			} else if (app_id === 2575) { // Hubspot forms. Set title.
				tplData.click2play_text = t('click2play_blocked', app_name);
			}
		}

		c2pHtml.push(c2p_tpl({ data: tplData }));
	});

	if (app_id === 2575) { // Hubspot forms. Adjust selector.
		c2pApp.ele = _getHubspotFormSelector(details.url);
	}
	// TODO top-level documents only for now
	_injectClickToPlay(tab_id).then((result) => {
		if (result) {
			sendMessage(tab_id, 'c2p', {
				app_id,
				data: c2pApp,
				html: c2pHtml
				// tabWindowId: message.tabWindowId
			});
		}
	});
}

/**
 * Build blocked redirect data global structure Inject Page-Level Click2Play on Redirect.
 * @memberOf BackgroundUtils
 *
 * @param  {number} 		requestId		request id
 * @param  {Object} 	redirectUrls	original url and redirect url as properties
 * @param {number}        	app_id 			tracker id
 *
 * @return {string}  					url of the internal template of the blocked redirect page
 */
export function buildRedirectC2P(requestId, redirectUrls, app_id) {
	const host_url = processUrl(redirectUrls.url).host;
	const redirect_url = processUrl(redirectUrls.redirectUrl).host;
	const app_name = bugDb.db.apps[app_id].name;

	globals.BLOCKED_REDIRECT_DATA = {};
	globals.BLOCKED_REDIRECT_DATA.app_id = app_id;
	globals.BLOCKED_REDIRECT_DATA.url = redirectUrls.redirectUrl;
	globals.BLOCKED_REDIRECT_DATA.blacklisted = !!policy.blacklisted(host_url);

	globals.BLOCKED_REDIRECT_DATA.translations = {
		blocked_redirect_page_title: t('blocked_redirect_page_title'),
		blocked_redirect_prevent: t(
			'blocked_redirect_prevent',
			// It is unlikely that apps pages will ever be translated
			//			[host_url, redirect_url, app_name, 'https://' + globals.APPS_SUB_DOMAIN + '.ghostery.com/' + conf.language + '/apps/' + encodeURIComponent(app_name.replace(/\s+/g, '_').toLowerCase())]),
			[host_url, redirect_url, app_name, `https://${globals.APPS_SUB_DOMAIN}.ghostery.com/en/apps/${encodeURIComponent(app_name.replace(/\s+/g, '_').toLowerCase())}`]
		),
		blocked_redirect_action_always_title: t('blocked_redirect_action_always_title'),
		blocked_redirect_action_through_once_title: t('blocked_redirect_action_through_once_title'),
		blocked_redirect_url_content: t('blocked_redirect_url_content', [redirectUrls.redirectUrl, app_name])
	};
	return chrome.extension.getURL('app/templates/blocked_redirect.html');
}

/**
 * Handle unblocking of trackers when C2P 'Always Allow' is clicked.
 * @memberOf BackgroundUtils
 *
 * @param  {number} 	app_id 			tracker id
 * @param  {string} 	tab_host 		host of the tab url
 */
export function allowAllwaysC2P(app_id, tab_host) {
	// Remove this tracker from blocked list
	const { selected_app_ids } = conf;
	delete selected_app_ids[app_id];
	conf.selected_app_ids = selected_app_ids;


	// Remove fron site-specific-blocked
	if (conf.site_specific_blocks.hasOwnProperty(tab_host) && conf.site_specific_blocks[tab_host].includes(+app_id)) {
		const index = conf.site_specific_blocks[tab_host].indexOf(+app_id);
		const { site_specific_blocks } = conf;
		site_specific_blocks[tab_host].splice(index);
		conf.site_specific_blocks = site_specific_blocks;
	}

	// Add tracker to site-specific-allowed
	const { site_specific_unblocks } = conf;
	if (!site_specific_unblocks.hasOwnProperty(tab_host)) {
		// create new array of unblocks for this host
		site_specific_unblocks[tab_host] = [];
	}
	if (!site_specific_unblocks[tab_host].includes(app_id)) {
		// push app_id to the unblocked list for this tab_host
		site_specific_unblocks[tab_host].push(app_id);
	}
	conf.site_specific_unblocks = site_specific_unblocks;
}

/**
 * Creates selector for hubspot form
 * @private
 *
 * @param  {string} url 	form request url
 * @return {string} 		selector
 */
function _getHubspotFormSelector(url) {
	// Hubspot url has a fixed format
	// https://forms.hubspot.com/embed/v3/form/532040/95b5de3a-6d4a-4729-bebf-07c41268d773?callback=hs_reqwest_0&hutk=941df50e9277ee76755310cd78647a08
	// The following three parameters are privacy-safe:
	// 532040 - partner id
	// 95b5de3a-6d4a-4729-bebf-07c41268d773 - form id on the page
	// hs_reqwest_0 - function which will be called on the client after the request
	//
	// hutk=941df50e9277ee76755310cd78647a08 -is user-specific (same every session)
	const tokens = url.substr(8).split(/\/|\&|\?|\#|\=/ig);
	return `form[id="hsForm_${tokens[5]}"]`;
}

/**
 * Inject dist/click_to_play.js content script
 * @private
 *
 * @param  {number} 		tab_id 		tab id
 * @return {Promise}    true/false
 */
function _injectClickToPlay(tab_id) {
	if (globals.C2P_LOADED) {
		return Promise.resolve(true);
	}

	const tab = tabInfo.getTabInfo(tab_id);
	if (!tab || tab.prefetched || tab.path.includes('_/chrome/newtab') || tab.protocol === 'about' || globals.EXCLUDES.includes(tab.host)) {
		// If the tab is prefetched, a chrome newtab or Firefox about:page, we can't add C2P to it.
		return Promise.resolve(true);
	}

	return injectScript(tab_id, 'dist/click_to_play.js', '', 'document_end').then(() => {
		globals.C2P_LOADED = true;
		return true;
	}).catch((err) => {
		log('_injectClickToPlay error', err);
		return false; // prevent sendMessage calls
	});
}

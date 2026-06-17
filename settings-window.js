import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';

import {createSettingsWindow} from './settings-window-ui.js';
import {
    configureNetBirdApplicationIdentity,
    NETBIRD_APPLICATION_ID,
    registerNetBirdIcon,
} from './windowIcon.js';


configureNetBirdApplicationIdentity();

const application = new Adw.Application({
    application_id: NETBIRD_APPLICATION_ID,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

application.connect('activate', app => {
    registerNetBirdIcon();
    createSettingsWindow(app).present();
});

application.run([]);

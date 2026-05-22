import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';

import {createSettingsWindow} from './settings-window-ui.js';


const APPLICATION_ID = 'io.netbird.gnome.ProfileSettings';


const application = new Adw.Application({
    application_id: APPLICATION_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

application.connect('activate', app => {
    createSettingsWindow(app).present();
});

application.run([]);

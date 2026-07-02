import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


const NETBIRD_PROFILE_STATE_DIR = 'netbird';


export async function readProfileEmail(profileName) {
    if (!profileName || profileName !== GLib.path_get_basename(profileName))
        return '';

    const statePath = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        NETBIRD_PROFILE_STATE_DIR,
        `${profileName}.state.json`,
    ]);

    try {
        const contents = await new Promise((resolve, reject) => {
            Gio.File.new_for_path(statePath).load_contents_async(null, (source, result) => {
                try {
                    const [, bytes] = source.load_contents_finish(result);
                    resolve(bytes);
                } catch (error) {
                    reject(error);
                }
            });
        });

        const profileState = JSON.parse(new TextDecoder().decode(contents));
        return typeof profileState.email === 'string' ? profileState.email.trim() : '';
    } catch {
        return '';
    }
}

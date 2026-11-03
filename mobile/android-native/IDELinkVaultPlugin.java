package org.francestudent.chat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;

@CapacitorPlugin(name = "IDELinkVault")
public class IDELinkVaultPlugin extends Plugin {
    private static final String ALIAS = "frst.ide-link.v1";
    private synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    @PluginMethod public void read(PluginCall call) {
        try {
            String encoded = getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).getString("pair", null);
            JSObject result = new JSObject();
            if (encoded != null) {
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length < 28 || bytes.length > 20000) throw new Exception();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 0, 12));
                cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
                result.put("value", new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) { call.reject("Le coffre Android est indisponible. Oublie l’association puis scanne à nouveau."); }
    }
    @PluginMethod public void save(PluginCall call) {
        try {
            String value = call.getString("value");
            if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 16384) throw new Exception();
            new JSObject(value);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] bytes = ByteBuffer.allocate(12 + encrypted.length).put(cipher.getIV()).put(encrypted).array();
            if (!getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).edit().putString("pair", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) throw new Exception();
            call.resolve();
        } catch (Exception error) { call.reject("L’association ne peut pas être mémorisée dans le coffre Android."); }
    }
    @PluginMethod public void remove(PluginCall call) {
        if (getContext().getSharedPreferences(ALIAS, Context.MODE_PRIVATE).edit().remove("pair").commit()) call.resolve();
        else call.reject("L’association ne peut pas être retirée du coffre Android.");
    }
}

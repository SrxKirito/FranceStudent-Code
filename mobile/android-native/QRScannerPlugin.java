package org.francestudent.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

@CapacitorPlugin(name = "QRScanner")
public class QRScannerPlugin extends Plugin {
    private boolean scanning;
    @PluginMethod public void scan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (scanning) { call.reject("Un scan est déjà ouvert."); return; }
            scanning = true;
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
            GmsBarcodeScanning.getClient(getActivity(), options).startScan()
                .addOnSuccessListener(barcode -> { scanning = false; JSObject result = new JSObject(); result.put("value", barcode.getRawValue()); call.resolve(result); })
                .addOnCanceledListener(() -> { scanning = false; JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result); })
                .addOnFailureListener(error -> { scanning = false; call.reject("Scanner indisponible. Vérifie Google Play Services ou utilise le lien et le PIN."); });
        });
    }
}

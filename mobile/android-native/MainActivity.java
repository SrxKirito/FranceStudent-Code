package org.francestudent.chat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IDELinkVaultPlugin.class);
        registerPlugin(QRScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

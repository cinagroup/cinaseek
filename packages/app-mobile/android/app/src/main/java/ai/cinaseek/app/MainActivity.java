package ai.cinaseek.app;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String APP_HOST = "cinaseek.ai";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() == null || getBridge().getWebView() == null) return;

        getBridge().getWebView().setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request.getOrigin();
                String[] resources = request.getResources();
                boolean trustedOrigin = "https".equals(origin.getScheme()) &&
                    APP_HOST.equals(origin.getHost());
                boolean audioOnly = resources.length == 1 &&
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]);
                if (!trustedOrigin || !audioOnly) {
                    request.deny();
                    return;
                }
                super.onPermissionRequest(request);
            }
        });
    }
}

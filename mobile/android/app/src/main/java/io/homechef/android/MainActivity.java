package io.homechef.android;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    private LocalDatabase localDatabase;
    public LocalDatabase getDatabase(){return localDatabase;}
    @Override protected void load(){
        localDatabase=new LocalDatabase(this,getIntent().getBooleanExtra("homechef_validation",false));
        android.webkit.WebView view=findViewById(com.getcapacitor.android.R.id.webview);
        view.addJavascriptInterface(localDatabase,"HomeChefSQLite");
        super.load();
    }
    @Override public void onDestroy(){
        try { if(localDatabase!=null)localDatabase.shutdown(); }
        finally { super.onDestroy(); }
    }
    @Override public void onCreate(Bundle savedInstanceState){
        registerPlugin(DataFilesPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this,new androidx.activity.OnBackPressedCallback(true){
            @Override public void handleOnBackPressed(){
                getBridge().getWebView().evaluateJavascript("Boolean(window.homechefBack && window.homechefBack())",result->{
                    if("true".equals(result))return;
                    moveTaskToBack(true);
                });
            }
        });
    }
}

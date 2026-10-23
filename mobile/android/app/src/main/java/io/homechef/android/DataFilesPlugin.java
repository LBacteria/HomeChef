package io.homechef.android;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;

@CapacitorPlugin(name="HomeChefFiles")
public class DataFilesPlugin extends Plugin {
    private boolean pending;
    private LocalDatabase database(){return ((MainActivity)getActivity()).getDatabase();}
    @PluginMethod public void exportBackup(PluginCall call){
        if(pending){call.reject("已有文件操作等待完成");return;}
        try{
            database().snapshot();pending=true;
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/octet-stream");
            intent.putExtra(Intent.EXTRA_TITLE,"HomeChef-"+new java.text.SimpleDateFormat("yyyyMMdd-HHmmss",java.util.Locale.ROOT).format(new java.util.Date())+".db");
            startActivityForResult(call,intent,"exportResult");
        }catch(Exception e){pending=false;call.reject(e.getMessage());}
    }
    @ActivityCallback private void exportResult(PluginCall call,ActivityResult result){
        pending=false;if(call==null)return;
        File source=new File(getContext().getCacheDir(),"homechef-export.db");
        if(result.getResultCode()!=android.app.Activity.RESULT_OK||result.getData()==null){source.delete();call.resolve(new JSObject().put("cancelled",true));return;}
        try(InputStream input=new FileInputStream(source);OutputStream output=getContext().getContentResolver().openOutputStream(result.getData().getData(),"wt")){
            if(output==null)throw new IOException("无法写入所选文件");byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);output.flush();call.resolve(new JSObject().put("cancelled",false));
        }catch(Exception e){call.reject("备份导出失败："+e.getMessage());}finally{source.delete();}
    }
    @PluginMethod public void importBackup(PluginCall call){
        if(pending){call.reject("已有文件操作等待完成");return;}
        pending=true;Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");
        try{startActivityForResult(call,intent,"importResult");}catch(Exception e){pending=false;call.reject(e.getMessage());}
    }
    @ActivityCallback private void importResult(PluginCall call,ActivityResult result){
        pending=false;if(call==null)return;
        if(result.getResultCode()!=android.app.Activity.RESULT_OK||result.getData()==null){call.resolve(new JSObject().put("cancelled",true));return;}
        File staged=new File(getContext().getCacheDir(),"homechef-import.db");
        try{
            try(InputStream input=getContext().getContentResolver().openInputStream(result.getData().getData());FileOutputStream output=new FileOutputStream(staged)){
                if(input==null)throw new IOException("无法读取备份");byte[] buffer=new byte[65536];int count;long total=0;
                while((count=input.read(buffer))!=-1){total+=count;if(total>67108864)throw new IOException("备份超过64MB限制");output.write(buffer,0,count);}output.getFD().sync();
            }
            database().restore(staged);call.resolve(new JSObject().put("cancelled",false));
        }catch(Exception e){call.reject("恢复未完成，原数据已保留："+e.getMessage());}finally{staged.delete();}
    }
}

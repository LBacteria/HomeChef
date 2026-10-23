package io.homechef.android;

import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import android.webkit.JavascriptInterface;
import org.json.JSONArray;
import org.json.JSONObject;

/** Private, synchronous SQLite adapter for bundled HomeChef business code.
 * The interface is injected only into this app's local WebView. No remote pages,
 * frames or network resources are permitted by the application CSP.
 */
public final class LocalDatabase {
    private final Context context;
    private volatile Thread databaseThread;
    private final java.util.concurrent.ExecutorService databaseExecutor=java.util.concurrent.Executors.newSingleThreadExecutor(work->{
        Thread thread=new Thread(work,"HomeChefDatabase");thread.setDaemon(true);databaseThread=thread;return thread;
    });
    private <T> T onDatabaseThread(java.util.concurrent.Callable<T> work) throws Exception {
        if(Thread.currentThread()==databaseThread)return work.call();
        try {return databaseExecutor.submit(work).get();}
        catch(java.util.concurrent.ExecutionException error){
            Throwable cause=error.getCause();if(cause instanceof Exception)throw (Exception)cause;throw new IllegalStateException(cause);
        }catch(InterruptedException error){Thread.currentThread().interrupt();throw error;}
    }
    private SQLiteDatabase database;
    private boolean failed;
    private boolean transactionActive;
    private boolean restoring;
    private boolean validationRequested;
    public LocalDatabase(Context context, boolean validationRequested) { this.context=context.getApplicationContext(); this.validationRequested=validationRequested && BuildConfig.DEBUG; System.loadLibrary("sqlcipher"); }
    @JavascriptInterface public synchronized boolean consumeValidationFlag(){boolean value=validationRequested;validationRequested=false;return value;}
    private SQLiteDatabase open() {
        if(failed) throw new IllegalStateException("数据库需要重新启动检查");
        if(database==null || !database.isOpen()) {
            java.io.File file=context.getDatabasePath("homechef.db"); file.getParentFile().mkdirs();
            java.io.File old=context.getDatabasePath("homechef.pre-restore.db");
            java.io.File marker=new java.io.File(context.getFilesDir(),"restore.pending");
            if(!restoring && marker.exists() && old.exists()) {
                if(file.exists() && !file.delete())throw new IllegalStateException("无法恢复原数据库");
                new java.io.File(file+"-wal").delete(); new java.io.File(file+"-shm").delete();
                if(!old.renameTo(file))throw new IllegalStateException("原数据库恢复失败"); marker.delete();
            }
            database=SQLiteDatabase.openDatabase(file.getAbsolutePath(), "", null, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.CREATE_IF_NECESSARY, null);
        }
        return database;
    }
    @JavascriptInterface public String execute(String sql,String parameters,String mode) {
        try {return onDatabaseThread(()->executeOnDatabaseThread(sql,parameters,mode));}
        catch(Exception error){
            JSONObject result=new JSONObject();
            try {result.put("ok",false);result.put("message","数据库连接已关闭，请重新打开应用");result.put("code","SQLITE_ERROR");}catch(Exception ignored){}
            return result.toString();
        }
    }
    private String executeOnDatabaseThread(String sql,String parameters,String mode) {
        JSONObject result=new JSONObject();
        try {
            if(sql==null || sql.length()>1048576) throw new IllegalArgumentException("SQL exceeds limit");
            JSONArray input=new JSONArray(parameters); Object[] args=new Object[input.length()]; String[] strings=new String[input.length()];
            for(int i=0;i<input.length();i++){Object value=input.isNull(i)?null:input.get(i);args[i]=value;strings[i]=value==null?null:String.valueOf(value);}
            SQLiteDatabase db=open();JSONObject data=new JSONObject();
            if("query".equals(mode)) {
                JSONArray columns=new JSONArray(),rows=new JSONArray();
                try(Cursor cursor=db.query(sql,args)) {
                    for(String name:cursor.getColumnNames())columns.put(name);
                    while(cursor.moveToNext()) {
                        JSONArray row=new JSONArray();
                        for(int i=0;i<cursor.getColumnCount();i++){
                            switch(cursor.getType(i)){
                                case Cursor.FIELD_TYPE_NULL: row.put(JSONObject.NULL);break;
                                case Cursor.FIELD_TYPE_INTEGER: row.put(cursor.getLong(i));break;
                                case Cursor.FIELD_TYPE_FLOAT: row.put(cursor.getDouble(i));break;
                                case Cursor.FIELD_TYPE_BLOB: throw new IllegalArgumentException("Binary fields are not supported");
                                default: row.put(cursor.getString(i));
                            }
                        }rows.put(row);
                    }
                }
                data.put("columns",columns);data.put("rows",rows);
            } else {
                if(args.length==0)db.execSQL(sql);else db.execSQL(sql,args);
                String command=sql.trim().toUpperCase();
                if(command.startsWith("BEGIN"))transactionActive=true;
                if(command.startsWith("COMMIT") || command.equals("ROLLBACK") || command.equals("ROLLBACK;"))transactionActive=false;
                data.put("changes",scalar(db,"SELECT changes()"));
                data.put("lastInsertRowid",scalar(db,"SELECT last_insert_rowid()"));
            }
            result.put("ok",true);result.put("data",data);
        }catch(Exception error){
            try {result.put("ok",false);result.put("message",error.getMessage()==null?"数据库操作失败":error.getMessage());result.put("code",constraint(error));}catch(Exception ignored){}
        }
        return result.toString();
    }
    private long scalar(SQLiteDatabase db,String sql){ try(Cursor cursor=db.rawQuery(sql,new String[]{})){if(!cursor.moveToFirst())return 0;return cursor.getLong(0);} }
    public java.io.File snapshot() throws Exception {return onDatabaseThread(this::snapshotOnDatabaseThread);}
    private java.io.File snapshotOnDatabaseThread() throws Exception {
        if(transactionActive)throw new IllegalStateException("请等待当前保存完成后再备份");
        java.io.File output=new java.io.File(context.getCacheDir(),"homechef-export.db");
        if(output.exists()&&!output.delete())throw new IllegalStateException("无法准备备份文件");
        open().execSQL("VACUUM INTO ?",new Object[]{output.getAbsolutePath()});
        return output;
    }
    private String schema(SQLiteDatabase db){
        StringBuilder result=new StringBuilder();
        try(Cursor cursor=db.rawQuery("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='android_metadata' ORDER BY type,name",new String[]{})){
            while(cursor.moveToNext())result.append(cursor.getString(0)).append('|').append(cursor.getString(1)).append('|').append(String.valueOf(cursor.getString(2)).replaceAll("\\s+"," ")).append('\n');
        }return result.toString();
    }
    public void restore(java.io.File input) throws Exception {onDatabaseThread(()->{restoreOnDatabaseThread(input);return null;});}
    private void restoreOnDatabaseThread(java.io.File input) throws Exception {
        if(transactionActive)throw new IllegalStateException("请等待当前保存完成后再恢复");
        if(input.length()<100 || input.length()>67108864)throw new IllegalArgumentException("备份文件大小不符合要求");
        SQLiteDatabase current=open();
        try(SQLiteDatabase candidate=SQLiteDatabase.openDatabase(input.getAbsolutePath(),"",null,SQLiteDatabase.OPEN_READONLY,null)){
            if(scalar(candidate,"PRAGMA application_id")!=1212377158)throw new IllegalArgumentException("这不是HomeChef安卓备份文件");
            try(Cursor cursor=candidate.rawQuery("PRAGMA integrity_check",new String[]{})){if(!cursor.moveToFirst()||!"ok".equals(cursor.getString(0)))throw new IllegalArgumentException("备份完整性检查失败");}
            try(Cursor cursor=candidate.rawQuery("PRAGMA foreign_key_check",new String[]{})){if(cursor.moveToFirst())throw new IllegalArgumentException("备份包含无效的数据关联");}
            if(!schema(current).equals(schema(candidate)))throw new IllegalArgumentException("备份结构不兼容，请使用相同版本的备份");
            String migrationSql="SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at";
            try(Cursor a=current.rawQuery(migrationSql,new String[]{});Cursor b=candidate.rawQuery(migrationSql,new String[]{})){
                while(a.moveToNext()){if(!b.moveToNext()||!a.getString(0).equals(b.getString(0))||a.getLong(1)!=b.getLong(1))throw new IllegalArgumentException("备份版本不匹配");}
                if(b.moveToNext())throw new IllegalArgumentException("备份来自更新版本");
            }
        }
        java.io.File target=context.getDatabasePath("homechef.db"),old=context.getDatabasePath("homechef.pre-restore.db");
        java.io.File marker=new java.io.File(context.getFilesDir(),"restore.pending");
        if(old.exists() && (marker.exists() || !old.delete()))throw new IllegalStateException("上次恢复尚未完成，请重启应用");
        // Keep one Android connection and DELETE journaling for synchronous
        // Drizzle transactions. Never switch WAL through raw SQL: that bypasses
        // the Android pool and can leave stale sidecars during replacement.
        current.disableWriteAheadLogging();
        try(Cursor journal=current.rawQuery("PRAGMA journal_mode",new String[]{})){
            if(!journal.moveToFirst() || !"delete".equalsIgnoreCase(journal.getString(0)))throw new IllegalStateException("无法安全关闭数据库日志");
        }
        current.close();database=null;
        for(String suffix:new String[]{"-wal","-shm","-journal"}){
            java.io.File sidecar=new java.io.File(target.getAbsolutePath()+suffix);
            if(sidecar.exists()&&!sidecar.delete())throw new IllegalStateException("无法清理数据库日志，原数据未改变");
        }
        if(!marker.createNewFile())throw new IllegalStateException("无法准备安全恢复");
        if(!target.renameTo(old)){marker.delete();throw new IllegalStateException("无法保护当前数据库");}
        if(!input.renameTo(target)){
            if(!old.renameTo(target))throw new IllegalStateException("恢复失败，请保留文件并重启应用");
            marker.delete();throw new IllegalStateException("无法写入恢复文件，已保留原数据");
        }
        restoring=true;
    }
    @JavascriptInterface public void confirmRestore(){
        try {onDatabaseThread(()->{confirmRestoreOnDatabaseThread();return null;});}
        catch(Exception error){throw new IllegalStateException(error.getMessage(),error);}
    }
    private void confirmRestoreOnDatabaseThread(){
        if(restoring){
            java.io.File marker=new java.io.File(context.getFilesDir(),"restore.pending");
            if(marker.exists()&&!marker.delete())throw new IllegalStateException("无法确认恢复，请重启应用");
            restoring=false;context.getDatabasePath("homechef.pre-restore.db").delete();
        }
    }
    /** Release pending transactions when Android destroys this Activity. */
    public void shutdown(){
        try {onDatabaseThread(()->{
            failed=true;
            try {
                if(database!=null && database.isOpen()){
                    try {if(transactionActive)database.execSQL("ROLLBACK");}
                    finally {database.close();}
                }
            }finally {database=null;transactionActive=false;}
            return null;
        });}catch(Exception error){android.util.Log.e("HomeChefDatabase","Database shutdown failed",error);}
        finally {databaseExecutor.shutdown();}
    }
    private String constraint(Exception error){
        String text=String.valueOf(error.getMessage()).toUpperCase();
        if(text.contains("UNIQUE CONSTRAINT")||text.contains("PRIMARY KEY"))return "SQLITE_CONSTRAINT_UNIQUE";
        if(text.contains("FOREIGN KEY CONSTRAINT"))return "SQLITE_CONSTRAINT_FOREIGNKEY";
        if(text.contains("CHECK CONSTRAINT"))return "SQLITE_CONSTRAINT_CHECK";
        if(text.contains("NOT NULL CONSTRAINT"))return "SQLITE_CONSTRAINT_NOTNULL";
        if(text.contains("CONSTRAINT"))return "SQLITE_CONSTRAINT";
        return "SQLITE_ERROR";
    }
}

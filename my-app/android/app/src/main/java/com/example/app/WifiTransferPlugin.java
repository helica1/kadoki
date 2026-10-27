package com.example.app;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Wi-Fi Transfer: a small HTTP server on the local network. A browser on the
 * same Wi-Fi opens http://<phone-ip>:<port>/ and gets the upload page
 * (public/wifi-transfer-page.html); each file is POSTed raw to
 * /upload?name=<file name> and streamed straight to <files>/WifiInbox/.
 * Every received file is reported to JS as a 'received' event
 * {name, path, size}; wifi-transfer.js imports them.
 * Only runs while started from the app (start / stop).
 */
@CapacitorPlugin(name = "WifiTransfer")
public class WifiTransferPlugin extends Plugin {

    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean running;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (!running) {
                int want = call.getInt("port", 8080);
                ServerSocket ss = null;
                for (int p = want; p < want + 20 && ss == null; p++) {
                    try { ss = new ServerSocket(p); } catch (Exception ignored) {}
                }
                if (ss == null) { call.reject("No free port"); return; }
                server = ss;
                running = true;
                acceptThread = new Thread(this::acceptLoop, "WifiTransfer");
                acceptThread.start();
            }
            JSObject r = new JSObject();
            String ip = localIp();
            r.put("ip", ip);
            r.put("port", server.getLocalPort());
            r.put("url", ip == null ? null : "http://" + ip + ":" + server.getLocalPort() + "/");
            call.resolve(r);
        } catch (Exception e) {
            call.reject("start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
        server = null;
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = server.accept();
                new Thread(() -> handle(s), "WifiTransfer-conn").start();
            } catch (Exception e) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(60000);
            InputStream in = sock.getInputStream();
            OutputStream out = sock.getOutputStream();
            // Request line + headers (up to the blank line).
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) return;
            String method = req[0], target = req[1];
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            String path = target, query = "";
            int q = target.indexOf('?');
            if (q >= 0) { path = target.substring(0, q); query = target.substring(q + 1); }

            if ("GET".equals(method) && ("/".equals(path) || "/index.html".equals(path))) {
                byte[] page = readAsset("public/wifi-transfer-page.html");
                respond(out, 200, "text/html; charset=utf-8", page);
            } else if ("POST".equals(method) && "/upload".equals(path)) {
                String name = safeName(param(query, "name"));
                long len = Long.parseLong(headers.getOrDefault("content-length", "-1"));
                if (name.isEmpty() || len < 0) { respond(out, 400, "text/plain", "bad request".getBytes()); return; }
                File dir = new File(getContext().getFilesDir(), "WifiInbox");
                if (!dir.exists()) dir.mkdirs();
                File dest = new File(dir, name);
                File tmp = new File(dir, "." + name + ".part");
                long got = 0;
                try (OutputStream fo = new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16)) {
                    byte[] buf = new byte[1 << 16];
                    while (got < len) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, len - got));
                        if (n < 0) break;
                        fo.write(buf, 0, n);
                        got += n;
                    }
                }
                if (got != len) { tmp.delete(); respond(out, 400, "text/plain", "incomplete".getBytes()); return; }
                if (dest.exists()) dest.delete();
                if (!tmp.renameTo(dest)) { respond(out, 500, "text/plain", "save failed".getBytes()); return; }
                respond(out, 200, "text/plain", "ok".getBytes());
                JSObject ev = new JSObject();
                ev.put("name", name);
                ev.put("path", dest.getAbsolutePath());
                ev.put("size", dest.length());
                notifyListeners("received", ev);
            } else {
                respond(out, 404, "text/plain", "not found".getBytes());
            }
        } catch (Exception ignored) {
        }
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int prev3 = 0, c;
        while ((c = in.read()) >= 0) {
            b.write(c);
            prev3 = ((prev3 << 8) | c) & 0xFFFFFFFF;
            if (prev3 == 0x0D0A0D0A) return new String(b.toByteArray(), 0, b.size() - 4, StandardCharsets.ISO_8859_1);
            if (b.size() > 32768) return null;
        }
        return null;
    }

    private static String param(String query, String key) {
        for (String kv : query.split("&")) {
            int e = kv.indexOf('=');
            if (e > 0 && kv.substring(0, e).equals(key)) {
                try { return URLDecoder.decode(kv.substring(e + 1), "UTF-8"); } catch (Exception ignored) {}
            }
        }
        return "";
    }

    /** A plain file name: no folders, no leading dots. */
    private static String safeName(String n) {
        if (n == null) return "";
        n = n.replace('\\', '/');
        n = n.substring(n.lastIndexOf('/') + 1).trim();
        while (n.startsWith(".")) n = n.substring(1);
        return n;
    }

    private static void respond(OutputStream out, int code, String type, byte[] body) throws Exception {
        String status = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 400 ? "Bad Request" : "Error";
        String h = "HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length +
            "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private byte[] readAsset(String name) throws Exception {
        try (InputStream in = getContext().getAssets().open(name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toByteArray();
        }
    }

    /** The phone's address on the local network (Wi-Fi first). */
    private static String localIp() {
        try {
            String fallback = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String ip = a.getHostAddress();
                    if (ni.getName().startsWith("wlan")) return ip;
                    if (a.isSiteLocalAddress() && fallback == null) fallback = ip;
                }
            }
            return fallback;
        } catch (Exception e) { return null; }
    }
}

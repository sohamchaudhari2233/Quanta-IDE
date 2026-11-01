import sys
import subprocess
import time
import random
import string
import os
import socket
import argparse
import logging

# -----------------------------------------------------------------------------
# Dependency Management
# -----------------------------------------------------------------------------
def check_dependencies():
    """Checks and installs required Python packages."""
    needed = ["pyngrok", "python-dotenv", "qrcode", "pinggy"]
    installed = []
    
    # Check what is missing
    for pkg in needed:
        try:
            if pkg == "pyngrok": from pyngrok import ngrok
            elif pkg == "python-dotenv": from dotenv import load_dotenv
            elif pkg == "qrcode": import qrcode
            elif pkg == "pinggy": import pinggy
            installed.append(pkg)
        except ImportError:
            pass

    missing = [pkg for pkg in needed if pkg not in installed]
    
    if missing:
        print(f"📦 Installing missing dependencies: {', '.join(missing)}...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
            print("✅ Dependencies installed.\n")
        except Exception as e:
            print(f"❌ Failed to install dependencies: {e}")
            sys.exit(1)

def check_node_environment():
    """Checks for Node.js and installs npm dependencies if needed."""
    # 1. Check if Node is installed
    try:
        subprocess.check_call(["node", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("❌ Error: Node.js is not installed. Please install it from https://nodejs.org/")
        sys.exit(1)

    # 2. Check for node_modules
    if not os.path.exists("node_modules"):
        print("📦 'node_modules' missing. Installing Node.js dependencies...")
        try:
            # shell=True often needed on Windows for npm. On *nix, 'npm' usually works directly if in PATH.
            is_windows = sys.platform == "win32"
            subprocess.check_call(["npm", "install"], shell=is_windows)
            print("✅ Node dependencies installed.\n")
        except Exception as e:
            print(f"❌ Failed to run 'npm install': {e}")
            sys.exit(1)

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def get_local_ip():
    """Robustly determines the local LAN IP address."""
    s = None
    try:
        # Connect to a public DNS server (doesn't actually send data)
        # This forces the OS to determine the correct outgoing interface
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

def generate_passcode():
    """Generates a 6-digit passcode."""
    return ''.join(random.choices(string.digits, k=6))

def print_qr(url):
    """Generates and prints a QR code to the terminal."""
    import qrcode
    qr = qrcode.QRCode(version=1, box_size=1, border=1)
    qr.add_data(url)
    qr.make(fit=True)
    # Using 'ANSI' implies standard block characters which work in most terminals
    # invert=True is often needed for dark terminals (white blocks on black bg)
    qr.print_ascii(invert=True)

# -----------------------------------------------------------------------------
# Main Execution
# -----------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Antigravity Phone Connect Launcher")
    parser.add_argument('--mode', choices=['local', 'web'], default='web', help="Mode to run in: 'local' (WiFi) or 'web' (Internet)")
    parser.add_argument('--provider', choices=['ngrok', 'cloudflare', 'pinggy'], help="Tunnel provider (defaults to .env TUNNEL_PROVIDER or 'ngrok')")
    args = parser.parse_args()

    # 1. Setup Environment
    check_dependencies()
    check_node_environment()
    
    # Suppress pyngrok noise (especially during shutdown)
    logging.getLogger("pyngrok").setLevel(logging.ERROR)
    
    from pyngrok import ngrok

    from dotenv import load_dotenv
    
    # Load .env if it exists
    load_dotenv()

    # Determine Provider
    provider = args.provider or os.environ.get('TUNNEL_PROVIDER', 'ngrok').lower()
    
    # Setup App Password
    passcode = os.environ.get('APP_PASSWORD')
    if not passcode:
        passcode = generate_passcode()
        os.environ['APP_PASSWORD'] = passcode # Set for child process
        print(f"⚠️  No APP_PASSWORD in .env. Using temporary: {passcode}")

    # 2. Start Node.js Server (Common to both modes)
    print(f"🚀 Starting Antigravity Server ({args.mode.upper()} mode)...")
    
    # Clean up old logs
    with open("server_log.txt", "w") as f:
        f.write(f"--- Server Started at {time.ctime()} ---\n")

    node_cmd = ["node", "server.js"]
    node_process = None
    
    try:
        # Redirect stdout/stderr to file
        log_file = open("server_log.txt", "a")
        if sys.platform == "win32":
            # On Windows, using shell=True can help with path resolution but makes killing harder.
            # We'll use shell=False and rely on PATH.
            node_process = subprocess.Popen(node_cmd, stdout=log_file, stderr=log_file, env=os.environ.copy())
        else:
            node_process = subprocess.Popen(node_cmd, stdout=log_file, stderr=log_file, env=os.environ.copy())
            
        time.sleep(2) # Give it a moment to crash if it's going to
        if node_process.poll() is not None:
            print("❌ Server failed to start immediately. Check server_log.txt.")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Failed to launch node: {e}")
        sys.exit(1)

    # 3. Mode Specific Logic
    final_url = ""
    
    try:
        if args.mode == 'local':
            ip = get_local_ip()
            port = os.environ.get('PORT', '3000')
            
            # Detect HTTPS
            protocol = "http"
            if os.path.exists('certs/server.key') and os.path.exists('certs/server.cert'):
                protocol = "https"
            
            final_url = f"{protocol}://{ip}:{port}"
            
            print("\n" + "="*50)
            print(f"📡 LOCAL WIFI ACCESS")
            print("="*50)
            print(f"🔗 URL: {final_url}")
            print(f"🔑 Passcode: Not required for local WiFi (Auto-detected)")
            
            print("\n📱 Scan this QR Code to connect:")
            print_qr(final_url)

            print("-" * 50)
            print("📝 Steps to Connect:")
            print("1. Ensure your phone is on the SAME Wi-Fi network as this computer.")
            print("2. Open your phone's Camera app or a QR scanner.")
            print("3. Scan the code above OR manually type the URL into your browser.")
            print("4. You should be connected automatically!")
            
        elif args.mode == 'web':
            port = os.environ.get('PORT', '3000')
            
            # Detect HTTPS
            protocol = "http"
            if os.path.exists('certs/server.key') and os.path.exists('certs/server.cert'):
                protocol = "https"
                
            addr = f"{protocol}://localhost:{port}"
            public_url = ""

            if provider == 'pinggy':
                print("PLEASE WAIT... Establishing Pinggy Tunnel...")
                try:
                    import pinggy
                    pinggy_token = os.environ.get('PINGGY_TOKEN')  # Optional: for persistent subdomain
                    pinggy_tunnel = pinggy.start_tunnel(
                        forwardto=f"localhost:{port}",
                        token=pinggy_token if pinggy_token else None,
                        localservertls=(protocol == "https")
                    )
                    # Prefer HTTPS URL from the returned list
                    tunnel_urls = pinggy_tunnel.urls if hasattr(pinggy_tunnel, 'urls') else []
                    public_url = next((u for u in tunnel_urls if u.startswith('https://')), None)
                    if not public_url and tunnel_urls:
                        public_url = tunnel_urls[0]  # fallback to first URL
                    if not public_url:
                        print("❌ Failed to obtain a Pinggy URL.")
                        sys.exit(1)
                except ImportError:
                    print("❌ Error: 'pinggy' package not found. Run: pip install pinggy")
                    sys.exit(1)
                except Exception as e:
                    print(f"❌ Failed to start Pinggy Tunnel: {e}")
                    sys.exit(1)

            elif provider == 'cloudflare':
                cf_name = os.environ.get('CLOUDFLARE_TUNNEL_NAME') or os.environ.get('CLOUDFLARE_TUNNEL_ID')
                cf_custom_url = os.environ.get('CLOUDFLARE_TUNNEL_URL')

                # Find cloudflared binary path
                cf_bin = "cloudflared"
                if sys.platform == "win32":
                    import shutil
                    if not shutil.which("cloudflared"):
                        common_paths = [
                            os.path.join(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"), "cloudflared", "cloudflared.exe"),
                            os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "cloudflared", "cloudflared.exe"),
                            os.path.join(os.environ.get("LOCALAPPDATA", ""), "bin", "cloudflared.exe")
                        ]
                        for path in common_paths:
                            if os.path.exists(path):
                                cf_bin = path
                                break

                import threading
                import re

                def drain_cloudflared_output(proc, log_path):
                    """Background thread: continuously reads cloudflared output to prevent pipe deadlock."""
                    try:
                        with open(log_path, "a", encoding="utf-8", errors="ignore") as lf:
                            for line in proc.stdout:
                                lf.write(line)
                                lf.flush()
                    except Exception:
                        pass

                def start_cloudflare_tunnel(cf_bin, addr, protocol):
                    """Start cloudflared and return (process, public_url)."""
                    cf_cmd = [cf_bin, "tunnel", "--url", addr, "--protocol", "http2"]
                    if protocol == "https":
                        cf_cmd.append("--no-tls-verify")

                    cf_proc = subprocess.Popen(
                        cf_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        universal_newlines=True
                    )

                    # Watch for the URL in early output
                    found_url = None
                    start_time = time.time()
                    timeout = 45  # seconds

                    while time.time() - start_time < timeout:
                        line = cf_proc.stdout.readline()
                        if not line:
                            if cf_proc.poll() is not None:
                                break
                            continue

                        if ".trycloudflare.com" in line:
                            match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
                            if match:
                                found_url = match.group(0)
                                break

                    if not found_url:
                        cf_proc.terminate()
                        return None, None

                    # Start background thread to drain remaining output (CRITICAL: prevents pipe deadlock crash)
                    drain_thread = threading.Thread(
                        target=drain_cloudflared_output,
                        args=(cf_proc, "cloudflared_log.txt"),
                        daemon=True
                    )
                    drain_thread.start()

                    return cf_proc, found_url

                if cf_name:
                    print(f"PLEASE WAIT... Starting Persistent Cloudflare Tunnel: {cf_name}...")
                    cf_cmd = [cf_bin, "tunnel", "run", cf_name]
                    public_url = cf_custom_url
                    
                    if not public_url:
                        print("⚠️  Warning: CLOUDFLARE_TUNNEL_URL not set. QR Code might be incorrect.")
                        public_url = "https://your-cloudflare-hostname.com"
                    
                    try:
                        cf_process = subprocess.Popen(cf_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        time.sleep(2)
                    except FileNotFoundError:
                        print("❌ Error: 'cloudflared' binary not found.")
                        sys.exit(1)
                else:
                    print("PLEASE WAIT... Establishing Ephemeral Cloudflare Tunnel...")
                    try:
                        cf_process, public_url = start_cloudflare_tunnel(cf_bin, addr, protocol)
                        
                        if not public_url:
                            print("❌ Failed to find Cloudflare Tunnel URL. Is 'cloudflared' installed?")
                            sys.exit(1)
                        
                        print(f"✅ Cloudflare Tunnel established: {public_url}")
                            
                    except FileNotFoundError:
                        print("❌ Error: 'cloudflared' binary not found. Please install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-run/")
                        sys.exit(1)
                    except Exception as e:
                        print(f"❌ Failed to start Cloudflare Tunnel: {e}")
                        sys.exit(1)
            else:
                # Default to Ngrok
                # Check Ngrok Token
                token = os.environ.get('NGROK_AUTHTOKEN')
                if token:
                    ngrok.set_auth_token(token)
                else:
                    print("⚠️  Warning: NGROK_AUTHTOKEN not found in .env. Tunnel might expire.")

                print("PLEASE WAIT... Establishing Ngrok Tunnel...")
                tunnel = ngrok.connect(addr, host_header="rewrite")
                public_url = tunnel.public_url
            
            # Magic URL with password
            final_url = f"{public_url}?key={passcode}"
            
            print("\n" + "="*50)
            print(f"   🌍 GLOBAL WEB ACCESS ({provider.upper()})")
            print("="*50)
            print(f"🔗 Base URL: {public_url}")
            print(f"🔑 Passcode: {passcode}")
            
            print("\n📱 Scan this Magic QR Code (Auto-Logins):")
            print_qr(final_url)

            print("-" * 50)
            print("📝 Steps to Connect:")
            print("1. Switch your phone to Mobile Data or Turn off Wi-Fi.")
            print("2. Open your phone's Camera app or a QR scanner.")
            print("3. Scan the code above to auto-login.")
            print(f"4. Or visit {public_url}")
            print(f"5. Enter passcode: {passcode}")
            print("6. You should be connected automatically!")

        print("="*50)
        print("✅ Server is running in background. Logs -> server_log.txt")
        print("⌨️  Press Ctrl+C to stop.")
        
        # Keep alive loop
        last_log_pos = 0
        cdp_warning_shown = False
        tunnel_restart_count = 0
        
        while True:
            time.sleep(1)
            
            # Check Node.js server process status
            if node_process.poll() is not None:
                print("\n❌ Server process died unexpectedly!")
                sys.exit(1)
            
            # Monitor Cloudflare tunnel process and auto-restart if it dies
            if args.mode == 'web' and provider == 'cloudflare' and 'cf_process' in dir() and cf_process:
                if cf_process.poll() is not None and tunnel_restart_count < 5:
                    tunnel_restart_count += 1
                    print(f"\n⚠️  Cloudflare tunnel died. Restarting... (attempt {tunnel_restart_count}/5)")
                    try:
                        cf_process, new_url = start_cloudflare_tunnel(cf_bin, addr, protocol)
                        if new_url:
                            public_url = new_url
                            final_url = f"{public_url}?key={passcode}"
                            print(f"✅ Tunnel restarted: {public_url}")
                            print("\n📱 NEW QR Code:")
                            print_qr(final_url)
                        else:
                            print("❌ Failed to restart tunnel.")
                    except Exception as e:
                        print(f"❌ Tunnel restart failed: {e}")
                
            # Monitor logs for errors
            try:
                if os.path.exists("server_log.txt"):
                    with open("server_log.txt", "r", encoding='utf-8', errors='ignore') as f:
                        f.seek(last_log_pos)
                        new_lines = f.read().splitlines()
                        last_log_pos = f.tell()
                        
                        for line in new_lines:
                            if "CDP not found" in line and not cdp_warning_shown:
                                print("\n" + "!"*50)
                                print("❌ ERROR: Antigravity Editor Not Detected!")
                                print("!"*50)
                                print("   The server cannot see your editor.")
                                print("   1. Close Antigravity.")
                                print("   2. Re-open it with the debug flag:")
                                print("      antigravity . --remote-debugging-port=9000")
                                print("   3. Or use the 'Open with Antigravity (Debug)' context menu.")
                                print("!"*50 + "\n")
                                cdp_warning_shown = True
            except Exception:
                pass

    except KeyboardInterrupt:
        print("\n\n👋 Shutting down...")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        # Cleanup
        try:
            if 'node_process' in locals() and node_process:
                node_process.terminate()
                try:
                    node_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    node_process.kill()
            
            if args.mode == 'web':
                if provider == 'pinggy' and 'pinggy_tunnel' in locals():
                    try:
                        pinggy_tunnel.stop()
                    except Exception:
                        pass
                elif provider == 'cloudflare' and 'cf_process' in locals():
                    try:
                        cf_process.terminate()
                    except Exception:
                        pass
                elif 'ngrok' in locals():
                    ngrok.kill()
        except Exception:
            pass
        
        if 'log_file' in locals() and log_file:
            log_file.close()

if __name__ == "__main__":
    main()


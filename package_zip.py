import zipfile
import os

zip_path = 'printforge-phase3.zip'
project_dir = '.'
exclude_dirs = {'.git', 'node_modules', '.next', 'dist', '.turbo', '__pycache__', '.claude', 'uploads'}
exclude_files = {'.env', 'printforge-phase2.zip', 'printforge-phase3.zip', 'printforge-deploy.zip', 'printforge.zip', 'package_zip.py'}

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            if f in exclude_files:
                continue
            filepath = os.path.join(root, f)
            arcname = os.path.relpath(filepath, project_dir).replace(os.sep, '/')
            try:
                zf.write(filepath, arcname)
            except Exception:
                pass

size_mb = os.path.getsize(zip_path) / 1024 / 1024
print(f'Created {zip_path} ({size_mb:.1f} MB)')

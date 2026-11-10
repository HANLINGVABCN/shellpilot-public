"""Main Android acceptance now uses the integrated workspace; no extra APK."""
import runpy
runpy.run_path('scripts/verify-android-integrated.py',run_name='__main__')

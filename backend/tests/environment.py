import os


# Collection and unittest imports must not inherit a developer's stateful target.
os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"

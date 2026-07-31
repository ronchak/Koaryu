import os


# The supported pytest runner must not inherit a developer's stateful target.
os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

function initialDark() {
  const stored = localStorage.getItem("theme");
  if (stored) return stored === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(initialDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      onClick={() => setDark(!dark)}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

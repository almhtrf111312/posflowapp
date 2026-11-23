import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/hooks/use-language";

const NotFound = () => {
  const location = useLocation();
  const { direction } = useLanguage();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" dir={direction}>
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-foreground tracking-tight tabular-nums">404</h1>
        <p className="text-lg text-muted-foreground">Oops! Page not found</p>
        <Button asChild>
          <a href="/">Return to Home</a>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;

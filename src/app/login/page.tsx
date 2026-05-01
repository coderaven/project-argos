"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") ?? "/";

  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push(from);
        router.refresh();
      } else {
        setError("Incorrect password. Try again.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center px-4">
      <Card className="w-full max-w-sm bg-slate-900/60 border-slate-800">
        <CardHeader className="text-center space-y-3 pt-8">
          <div className="flex justify-center">
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <Eye className="w-6 h-6 text-red-400" />
            </div>
          </div>
          <CardTitle className="text-white text-xl">Project Argos</CardTitle>
          <CardDescription className="text-slate-400 text-sm">
            Enter your access password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-red-500/50"
              autoFocus
              disabled={loading}
            />
            {error && (
              <p className="text-red-400 text-xs text-center">{error}</p>
            )}
            <Button
              type="submit"
              disabled={loading || !password}
              className="w-full bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              {loading ? "Verifying..." : "Access Argos"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

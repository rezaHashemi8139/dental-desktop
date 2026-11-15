import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [testDbMsg, setTestDbMsg] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  async function testDb() {
    try {
      const result = await invoke("test_db_connection");
      setTestDbMsg(result as string);
    } catch (error) {
      setTestDbMsg(error as string);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to Smart Management Base</CardTitle>
          <CardDescription>Tauri + React + shadcn/ui</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              greet();
            }}
          >
            <Input
              id="greet-input"
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Enter a name..."
            />
            <Button type="submit">Greet</Button>
          </form>
          {greetMsg && <p className="text-sm">{greetMsg}</p>}

          <Button variant="outline" onClick={testDb}>
            Test Database Connection
          </Button>
          {testDbMsg && (
            <p className="text-sm text-muted-foreground">{testDbMsg}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default App;

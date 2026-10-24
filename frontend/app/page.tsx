"use client";
import { useEffect } from "react";
import GameCanvas from "@/components/GameCanvas";
import { BottomBar, Onboarding, SidePanel, Toasts, TopBar } from "@/components/Ui";
import { boot, rememberedStart } from "@/lib/game";

export default function Page() {
  useEffect(() => {
    void boot().then(rememberedStart);
  }, []);
  return (
    <main className="app">
      <TopBar />
      <div className="stage">
        <div className="board-wrap">
          <GameCanvas />
          <Onboarding />
          <Toasts />
        </div>
        <SidePanel />
      </div>
      <BottomBar />
    </main>
  );
}

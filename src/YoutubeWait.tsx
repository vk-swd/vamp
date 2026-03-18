import { useState } from "react";

interface YoutubeWaitProps {
  onReload: () => void;
}

export function YoutubeWait({ onReload }: YoutubeWaitProps) {
  const [buttDis, setDisBut] = useState(false);


  function pressButt() {
        if (buttDis) {
            return;
        }
        setDisBut(true)
        setTimeout(() => setDisBut(false), 2000);
        onReload();
  }

  return (
    <div className="yt-loading-widget">
      <div className="yt-loading-spinner" />
      <p className="yt-loading-msg">Loading YouTube player…</p>  
        <button className="btn btn-secondary ctrl-btn" onClick={pressButt} disabled={buttDis}>
            &#8635; Reload
        </button>
    </div>
  );
}

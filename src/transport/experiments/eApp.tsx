import { Button } from "../../ui/elements";




export default function EApp() {


    const ws = new WebSocket("wss://redacted");
    return (
        <Button onClick={() => {
            console.log("clicked");
        }}>Hello</Button>
    )
}
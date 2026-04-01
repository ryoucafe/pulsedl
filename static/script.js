function test() {
    document.getElementById("result").innerHTML = "Message from JS file!";
}
document.getElementById("callPython").addEventListener("click", async function() {
    const resultElement = document.getElementById("pythonResult");

    try {
        const response = await fetch("/api/ping");

        const data = await response.json();
        resultElement.innerHTML = `Response from Python: ${data.message}`;

    } catch (error) {
        resultElement.innerHTML = `Error: ${error.message}`;
        console.error(error);
    }
});
document.getElementById("downloadButton").addEventListener("click", async function() {
    try {
        const urlInput = document.getElementById("url");
        const userUrl = urlInput.value.trim();

        
        const response = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: userUrl })
        });



        const data = await response.json();
        console.log("Python replied:", data);   // helpful for debugging
    
    } catch (error) {
        console.error("Error during download:", error);
    }
});

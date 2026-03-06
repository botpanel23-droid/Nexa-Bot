import express from "express"

const app = express()

app.get("/", (req,res)=>{
res.send("Bot Alive")
})

app.listen(8080)

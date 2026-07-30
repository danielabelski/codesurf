process.on('SIGTERM', () => {
  process.stdout.write('sigterm-ignored\n')
})

process.stdout.write(`ready:${process.pid}\n`)
setInterval(() => {}, 1_000)

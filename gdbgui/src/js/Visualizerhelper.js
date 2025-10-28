var DigitsumMode = -1;
var FactorsumMode = -1;
var Gcdmode = -1;
var FactorpowerMode = -1;
var Gridindex = 0;
// var Tmparray = []
// var Totalarray = []
const gridMap = {};
const divMap = {};
const Visualizerhelper = {
    log: function(data) {
        console.log(data);
    },
    run: function(data) {
        // 找到被選中的 radio
        const selected = document.querySelector('input[name="mode"]:checked');
        if (!selected) {
            console.log("請先選擇模組");
            return;
        }
        const moduleName = selected.id; // 取得 radio id
        const module = Visualizerhelper[moduleName];

        if (module && typeof module.drawGrid === "function") {
            module.drawGrid(data); // 呼叫對應模組的 drawGrid
        } else {
            console.log("找不到模組或 drawGrid 方法");
        }
    },
    addGridLines: function(number) {
      const container = document.getElementById('grid-container');
      const col = document.createElement('div');
      col.className = 'column';
      for (let i = 0; i < number; i++) {
        const div = document.createElement('div');
        div.className = 'grid-item';
        div.textContent = ``;
        col.appendChild(div);
        gridMap[Gridindex + i] = div;
      }
      container.appendChild(col);
    },
    changeText: function(i,str) {
      gridMap[i]?.textContent = `${str}`;
      divMap[i]?.textContent = `${str}`;
    },
    Digitsum: {
        drawGrid: function(data) {
            const container = document.getElementById('grid-container');
            let n = undefined;
            let sum = undefined;
            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "n");
                if (found) {
                    n = found.value;
                }
            });

            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "sum");
                if (found) {
                    sum = found.value;
                }
            });

            if (n != undefined && sum != undefined) {
                switch (DigitsumMode) {
                    case 0:
                        Visualizerhelper.addGridLines(3);
                        Visualizerhelper.changeText(Gridindex,n);
                        // Tmparray.push(`n = ${n}`);
                        Gridindex++;
                        break

                    case 1:
                        Visualizerhelper.changeText(Gridindex,sum);
                        // Tmparray.push(`sum = ${sum}`);
                        Gridindex++;
                        break

                    case 2:
                        Visualizerhelper.changeText(Gridindex,n);
                        // Tmparray.push(`n = ${n}`);
                        // Totalarray.push(Tmparray);
                        // Tmparray = []
                        Gridindex++;
                        break;
                    default:
                        Visualizerhelper.addGridLines(3);
                        Visualizerhelper.changeText(0,'n');
                        Visualizerhelper.changeText(1,'sum');
                        Visualizerhelper.changeText(2,'n');

                        Gridindex = 3;
                        break
                }
                // console.table(Totalarray);
                DigitsumMode = (DigitsumMode+1)%3;
            }
            // console.log("data = ", data);       // 顯示物件
            // console.table(data);                 // 如果是陣列或物件陣列，表格化顯示
        }
    },
    Factorsum: {
        drawGrid: function(data) {

            let d = undefined;
            let sum = undefined;
            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "d");
                if (found) {
                    d = found.value;
                }
            });

            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "sum");
                if (found) {
                    sum = found.value;
                }
            });
            if (d != undefined && sum != undefined) {
                switch(FactorsumMode) {
                    case 0:
                        Visualizerhelper.addGridLines(2);
                        Visualizerhelper.changeText(Gridindex,d);
                        Gridindex++;
                        break

                    case 1:
                        Visualizerhelper.changeText(Gridindex,sum);
                        Gridindex++
                        break

                    default:
                        Visualizerhelper.addGridLines(2);
                        Visualizerhelper.changeText(0,'d');
                        Visualizerhelper.changeText(1,'sum');
                        Gridindex = 2;
                        break
                }
                FactorsumMode = (FactorsumMode+1)%2;
            }
        }
    },
    Gcd: {
        drawGrid: function(data) {

            let a = undefined;
            let b = undefined;
            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "a");
                if (found) {
                    a = found.value;
                }
            });

            data.forEach(item => {
                const found = item?.payload?.variables?.find(v => v.name === "b");
                if (found) {
                    b = found.value;
                }
            });
            if (a != undefined && b != undefined) {
                switch(Gcdmode) {
                    case 0:
                        Visualizerhelper.addGridLines(2);
                        Visualizerhelper.changeText(Gridindex,a);
                        Visualizerhelper.changeText(Gridindex+1,b);
                        Gridindex+=2;
                        break

                    case 1:
                        Visualizerhelper.addGridLines(2);
                        Visualizerhelper.changeText(Gridindex,a);
                        Visualizerhelper.changeText(Gridindex+1,b);
                        Gridindex+=2;
                        break

                    default:
                        Visualizerhelper.addGridLines(2);
                        Visualizerhelper.changeText(0,'a');
                        Visualizerhelper.changeText(1,'b');
                        Gridindex = 2;
                        break
                }
                Gcdmode = (Gcdmode+1)%2;
            }
        }
    },
    Factorpower: {

    }
};

export default Visualizerhelper;
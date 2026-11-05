// 錯誤教案 #2：陣列越界（寫到相鄰的欄位）
#include <iostream>

struct Block {
  int data[4];                           //@ @guide data 有 4 格，索引只能是 0 到 3 
  int guard;                             //@ @guide guard 應該永遠是 42 
};

int main() {                             //@ @tts [next] 程式開始，b 裡有 4 格 data 和 1 格 guard
  Block b;                               //@ @tts [next] 建立 b
  b.guard = 42;                          //@ @tts [next] 把 guard 設為 42
  for (int i = 0; i <= 4; i++) {         //@ @tts [next] i 從 0 跑到 4，共 5 次
    b.data[i] = i * 10;                  //@ @guide 執行後 data[i] 被寫入 i 乘 10；i 為 4 時寫到的其實是 guard @bug data 只有 4 格（索引 0 到 3）。i 等於 4 時，data[4] 的位置其實就是 guard，這一次寫入把 guard 蓋掉了 @tts [next] 把 {i} 乘 10 寫進 data 的第 {i} 格
  }                                      //@ @tts [next] 這一圈結束
  std::cout << "guard = " << b.guard << "（應為 42）" << std::endl;  //@ @tts [next] 印出 guard，應該是 42，實際不是
  return 0;                              //@ @tts [next] 回傳 0，main 即將結束
}  //@ @tts [continue] 教案播放完畢
